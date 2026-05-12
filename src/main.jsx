import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './style.css'

// Catch errors for mobile debugging
window.onerror = function(msg, url, lineNo, columnNo, error) {
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div style="color: red; padding: 20px;">
      <h3>Error!</h3>
      <p>${msg}</p>
      <small>${url}:${lineNo}</small>
    </div>`;
  }
  return false;
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
