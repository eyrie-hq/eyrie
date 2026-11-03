/**
 * A client-visible variable with a secret-sounding name: its value ships to
 * browsers. The URL below is the safe variant.
 */
export const clientKey = process.env.NEXT_PUBLIC_API_KEY;
export const apiUrl = process.env.NEXT_PUBLIC_API_URL;
