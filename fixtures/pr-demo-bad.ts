// Fixture for the PR-level gate demo. Deliberately broken in two ways an agent
// plausibly produces: an invented dependency and a credential written inline.
// Nothing imports this file; it exists to be caught.
import { withRetry } from '@acme-internal/retry-policy-v3';

const STRIPE_SECRET_KEY = "sk_live_51QhallucinatedKeyForTheGateDemo00";

export const fetchInvoice = withRetry(async (id: string) => {
  const response = await fetch(`https://api.stripe.com/v1/invoices/${id}`, {
    headers: { authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  return response.json();
});
