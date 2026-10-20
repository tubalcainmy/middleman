// Bank account names rarely match what people type exactly: order differs,
// middle names are dropped, initials are used. We require overlap, not equality.

const tokens = (name) =>
  String(name || '')
    .toUpperCase()
    .replace(/[^A-Z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1);

export function namesMatch(typedName, accountName) {
  const typed = tokens(typedName);
  const account = new Set(tokens(accountName));
  if (typed.length < 2 || account.size === 0) return false;
  const overlap = typed.filter((t) => account.has(t)).length;
  return overlap >= Math.min(2, account.size);
}
