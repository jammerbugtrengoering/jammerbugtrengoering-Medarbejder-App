// src/MedarbejderMain.jsx
// Entry point for the standalone medarbejder app.
// 
// Setup:
// 1. Create a second Vite project: npm create vite@latest medarbejder-app -- --template react
// 2. Copy MedarbejderApp.jsx and supabaseClient.js into src/
// 3. Replace src/main.jsx with this file (rename to main.jsx)
// 4. Same .env as the planning app (same Supabase project)
// 5. Deploy to Netlify as a separate site (e.g. medarbejder.jeresfirma.dk)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import MedarbejderApp from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MedarbejderApp />
  </StrictMode>,
)
