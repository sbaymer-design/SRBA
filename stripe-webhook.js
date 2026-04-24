// api/stripe-webhook.js
// Vercel Serverless Function — recibe webhooks de Stripe y actualiza Supabase

const SUPABASE_URL = 'https://gybbnsglqvinwawqplmr.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function verifyStripeSignature(rawBody, signature, secret) {
  const encoder = new TextEncoder();
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t=')).split('=')[1];
  const sigPart = parts.find(p => p.startsWith('v1=')).split('=')[1];
  const payload = `${timestamp}.${rawBody.toString()}`;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (computed !== sigPart) throw new Error('Firma inválida');
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300) throw new Error('Webhook expirado');
  return JSON.parse(rawBody.toString());
}

async function supabaseUpsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }
  return res;
}

async function supabaseUpdate(table, match, data) {
  const params = Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase update error: ${err}`);
  }
}

function getPlanFromPriceId(priceId) {
  const PRO_PRICE = 'price_1TPnW92OeVtjAJocDqkjzMB3';
  const SCALE_PRICE = 'price_1TPnWu2OeVtjAJocHuK7HfyI';
  if (priceId === PRO_PRICE) return 'pro';
  if (priceId === SCALE_PRICE) return 'scale';
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) return res.status(400).json({ error: 'No signature' });

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = await verifyStripeSignature(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  console.log('Stripe event received:', event.type);

  try {
    switch (event.type) {

      // ── SUSCRIPCIÓN CREADA / ACTIVADA ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;
        const email = session.customer_email || session.customer_details?.email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const clientRef = session.client_reference_id; // email del usuario

        // Obtener detalles de la suscripción para saber el plan
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
          headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
        });

        // Guardamos el pago verificado en Supabase
        await supabaseUpsert('subscriptions', {
          email: email || clientRef,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          status: 'active',
          plan: 'pro', // se actualiza en el siguiente evento
          updated_at: new Date().toISOString()
        });

        console.log(`✅ Checkout completado para ${email}`);
        break;
      }

      // ── SUSCRIPCIÓN ACTUALIZADA (confirma el plan exacto) ──
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const plan = getPlanFromPriceId(priceId);
        const customerId = sub.customer;
        const status = sub.status; // active, past_due, canceled...

        if (!plan) {
          console.log('Plan no reconocido para price:', priceId);
          break;
        }

        // Buscar email del cliente en Stripe
        const custRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
          headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
        });
        const customer = await custRes.json();
        const email = customer.email;

        await supabaseUpsert('subscriptions', {
          email,
          stripe_customer_id: customerId,
          stripe_subscription_id: sub.id,
          plan,
          status: status === 'active' ? 'active' : 'inactive',
          price_id: priceId,
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString()
        });

        console.log(`✅ Suscripción ${status} — ${email} → plan ${plan}`);
        break;
      }

      // ── SUSCRIPCIÓN CANCELADA ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabaseUpdate('subscriptions',
          { stripe_subscription_id: sub.id },
          { status: 'cancelled', plan: 'free', updated_at: new Date().toISOString() }
        );
        console.log(`❌ Suscripción cancelada: ${sub.id}`);
        break;
      }

      // ── PAGO FALLIDO ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          await supabaseUpdate('subscriptions',
            { stripe_subscription_id: subId },
            { status: 'past_due', updated_at: new Date().toISOString() }
          );
        }
        console.log(`⚠️ Pago fallido para suscripción: ${subId}`);
        break;
      }

      default:
        console.log(`Evento ignorado: ${event.type}`);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('Error procesando webhook:', err);
    res.status(500).json({ error: err.message });
  }
}
