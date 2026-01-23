// Buffer polyfill MUST be first - before any other imports
import { Buffer } from 'buffer'
globalThis.Buffer = Buffer
window.Buffer = Buffer

import React from 'react'
import ReactDOM from 'react-dom/client'
import { Providers } from './src/providers'
import Rollions from './src/rollions-unified.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Providers>
      <Rollions />
    </Providers>
  </React.StrictMode>,
)
