import './styles.css'

import { createRoot } from 'react-dom/client'

import { App } from './App'
import { boot } from './store'

void boot()
createRoot(document.getElementById('root')!).render(<App />)
