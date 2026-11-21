/** "+14165550123" → "(416) 555-0123"; other countries keep the international form. */
export function formatContactPhone(phone: string): string {
  const match = /^\+1([2-9][0-9]{2})([0-9]{3})([0-9]{4})$/u.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}
