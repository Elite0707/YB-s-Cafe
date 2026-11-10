import { ArrowRight, Check, Coffee, QrCode } from "lucide-react";
import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";

export function Landing() {
  return <main className="landing-page">
    <div className="landing-grain" aria-hidden="true" />
    <nav className="landing-nav" aria-label="Main navigation">
      <Link to="/" className="brand-lockup" aria-label="Cafe ordering home">
        <span className="brand-mark"><Coffee size={18} /></span>
        <span>Cafe Ordering</span>
      </Link>
      <div className="landing-nav-actions"><ThemeToggle /><Link to="/admin/login" className="quiet-link">Cafe team? <span>Sign in <ArrowRight size={14} /></span></Link></div>
    </nav>
    <section className="landing-hero">
      <div className="landing-copy">
        <span className="eyebrow"><i className="eyebrow-dot" />ORDERING MADE SIMPLE</span>
        <h1>Good coffee.<br /><em>More time together.</em></h1>
        <p>Browse the menu, make your order your own, and enjoy a little more time around the table.</p>
        <div className="landing-actions">
          <Link to="/admin/login" className="button button-dark">Cafe team sign in <ArrowRight size={16} /></Link>
          <a className="button-quiet" href="#how-it-works">How it works</a>
        </div>
        <div className="landing-proof">
          <span><QrCode size={15} /> Scan your table QR</span>
          <span><Check size={14} /> No account needed</span>
        </div>
      </div>
      <div className="landing-visual" aria-hidden="true">
        <div className="visual-sun" />
        <div className="visual-photo">
          <div className="coffee-art"><div className="cup"><span className="foam">☕</span></div><div className="saucer" /></div>
          <div className="visual-label"><span>MADE FOR YOUR MOMENT</span><b>A little pause, well spent.</b></div>
        </div>
        <div className="visual-card visual-card-top"><span className="mini-qr"><QrCode size={19} /></span><span><b>Scan to order</b><small>From right where you are</small></span></div>
        <div className="visual-card visual-card-bottom"><span className="visual-check"><Check size={12} /></span><span><b>Order sent to the cafe</b><small>Track it as it is prepared</small></span></div>
      </div>
    </section>
    <footer id="how-it-works" className="landing-foot"><span>CAFE ORDERING, MADE EASIER</span><span>Scan · Choose · Enjoy</span></footer>
  </main>;
}
