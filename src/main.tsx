import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Sistem Penangkapan Error Layar Blank
class ErrorBoundary extends React.Component<any, { hasError: boolean; errorMsg: string }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, errorMsg: "" };
  }

  static getDerivedStateFromError(error: any) {
    // Tangkap error dan tampilkan di layar
    return { hasError: true, errorMsg: error.toString() + "\n" + error.stack };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ color: '#ff6b6b', padding: '30px', fontFamily: 'Consolas, monospace', lineHeight: '1.6' }}>
          <h2>⚠️ APLIKASI CRASH!</h2>
          <p>Terjadi kesalahan pada kode UI. Silakan fotokan pesan di bawah ini:</p>
          <hr style={{ borderColor: '#ff6b6b' }} />
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px' }}>{this.state.errorMsg}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
