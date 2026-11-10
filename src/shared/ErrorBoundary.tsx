import React from "react";

type State = { failed: boolean };

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled application render error", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return <main className="fatal-error"><span className="eyebrow eyebrow-green">YB'S BREWING</span><h1>Something went wrong.</h1><p>Refresh this page to continue. Your order details remain safely on the server.</p><button className="button button-dark" onClick={() => window.location.reload()}>Refresh page</button></main>;
    }
    return this.props.children;
  }
}
