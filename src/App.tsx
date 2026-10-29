import { Link, Route, Routes } from 'react-router';
import DevPage from './dev/DevPage';

function Sessions() {
  return (
    <main className="p-4">
      <h1 className="text-xl font-semibold">Refr</h1>
      {/* Until Milestone 2 replaces this screen, the dev page is the only thing to test. */}
      <Link
        to="/dev"
        className="mt-4 inline-flex min-h-11 items-center rounded-md border border-border px-4 text-accent"
      >
        Open the dev test page
      </Link>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Sessions />} />
      <Route path="/dev" element={<DevPage />} />
    </Routes>
  );
}
