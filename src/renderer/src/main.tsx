import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './theme.css'
import './desktop.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
