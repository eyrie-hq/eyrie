/** Safe variant: UI code reads only a public variable. */
export function SafePanel() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  const save = () => fetch(`${apiUrl}/api/safe-notes`, { method: 'POST' });
  return <button onClick={save}>Save note</button>;
}
