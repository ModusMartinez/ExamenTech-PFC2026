import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FotosProvaLocalPanel } from '../components/FotosProvaLocalPanel'
import '../index.css'
import '../App.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="dashboard-content">
      <p className="overline">DEMONSTRAÇÃO LOCAL</p>
      <FotosProvaLocalPanel />
    </main>
  </StrictMode>,
)
