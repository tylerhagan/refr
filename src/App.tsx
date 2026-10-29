import { Route, Routes } from 'react-router';

function Sessions() {
  return (
    <main className="p-4">
      <h1 className="text-xl font-semibold">Refr</h1>
    </main>
  );
}

function DevPage() {
  return (
    <main className="p-4">
      <p className="text-muted text-sm">Dev page placeholder</p>
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
