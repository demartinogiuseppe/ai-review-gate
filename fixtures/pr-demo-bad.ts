// Same fixture, now clean: the invented dependency is gone and the credential
// comes from the environment. The ai-review check should go green on this commit
// and edit its existing comment rather than posting a second one.
const stripeSecretKey = process.env['STRIPE_SECRET_KEY'] ?? '';

export const fetchInvoice = async (id: string): Promise<unknown> => {
  const response = await fetch(`https://api.stripe.com/v1/invoices/${id}`, {
    headers: { authorization: `Bearer ${stripeSecretKey}` },
  });
  return response.json();
};
