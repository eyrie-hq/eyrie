/** A panel that reads a server-only variable straight into UI code. */
export function LeakPanel() {
  const dsn = process.env.DATABASE_URL;
  const save = () => fetch('/api/notes', { method: 'POST', body: JSON.stringify({ dsn }) });
  return <button onClick={save}>Save note</button>;
}
