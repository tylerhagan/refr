import { Route, Routes } from 'react-router';
import DevPage from './dev/DevPage';

function Sessions() {
  return (
    <main className="p-4">
      <h1 className="text-xl font-semibold">Refr</h1>
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
