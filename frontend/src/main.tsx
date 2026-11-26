import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createDemoSource } from './demo';
import { createLiveSource } from './live';
import './style.css';

// ?demo=1 forces the offline simulator. Otherwise use the API if it answers.
async function boot() {
  const forceDemo = new URLSearchParams(location.search).has('demo');
  let live = false;
  if (!forceDemo) { try { live = (await fetch('/api/health')).ok; } catch { live = false; } }
  const source = live ? createLiveSource('') : createDemoSource();
  createRoot(document.getElementById('root')!).render(<App source={source} />);
}
boot();
