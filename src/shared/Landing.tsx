import { ArrowDown, ArrowRight, Coffee, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";

export function Landing() {
  return <main className="yb-home">
    <section className="yb-home-hero" aria-labelledby="yb-home-title">
      <div className="yb-home-hero-shade" />
      <nav className="yb-nav yb-shell" aria-label="Main navigation">
        <Link to="/" className="yb-brand" aria-label="YB'S BREWING home">
          <span className="yb-brand-seal"><Coffee size={21} strokeWidth={1.5} /></span>
          <span className="yb-brand-type"><b>YB'S</b><small>BREWING</small></span>
        </Link>
        <div className="yb-nav-links"><a href="#yb-story">The space</a><a href="#yb-pours">Our kind of coffee</a></div>
        <Link to="/admin/login" className="yb-team-link">Cafe team <ArrowRight size={14} /></Link>
      </nav>
      <div className="yb-home-hero-content yb-shell">
        <div className="yb-hero-copy">
          <span className="yb-kicker"><i /> COFFEE · COMPANY · A LITTLE PAUSE</span>
          <h1 id="yb-home-title">Come for a cup.<br /><em>Stay for the feeling.</em></h1>
          <p>A neighborhood coffee house with room to slow down, settle in, and make the moment yours.</p>
          <div className="yb-hero-actions">
            <a className="yb-button-gold" href="#yb-story">Step inside <ArrowDown size={15} /></a>
            <span className="yb-scan-hint"><span className="yb-scan-ring"><Coffee size={16} /></span> At the cafe? Scan your table QR to order.</span>
          </div>
        </div>
        <div className="yb-hero-signature" aria-hidden="true"><span>YB'S</span><i /> BREWING</div>
        <div className="yb-hero-index"><span>01</span><i /> A PLACE TO LINGER</div>
      </div>
      <a className="yb-scroll-note" href="#yb-story" aria-label="Scroll to discover the cafe"><span /> SCROLL TO DISCOVER</a>
    </section>

    <section id="yb-story" className="yb-story-section">
      <div className="yb-story-grid yb-shell">
        <div className="yb-story-copy">
          <span className="yb-kicker yb-kicker-dark"><i /> A LITTLE ROOM OF YOUR OWN</span>
          <h2>Made for the<br /><em>moments between.</em></h2>
          <p>Ribbed midnight walls, a deep teal counter, and warm light that makes an ordinary afternoon feel like yours. YB'S BREWING is a place to catch your breath, meet your people, or simply enjoy one good cup.</p>
          <a className="yb-text-link" href="#yb-pours">Get to know our corner <ArrowRight size={15} /></a>
          <div className="yb-story-rule"><span>GOOD THINGS TAKE A MOMENT</span><i /></div>
        </div>
        <figure className="yb-interior-frame">
          <img src="/images/yb-brewing-interior.jpg" alt="Inside YB'S BREWING: a softly lit coffee counter framed by deep navy ribbed walls" loading="lazy" />
          <figcaption><span>THE COUNTER</span><b>Come as you are.</b></figcaption>
          <span className="yb-frame-corner" aria-hidden="true" />
        </figure>
        <div className="yb-story-index" aria-hidden="true"><span>YB'S BREWING</span><i /></div>
      </div>
    </section>

    <section id="yb-pours" className="yb-pours-section">
      <div className="yb-shell">
        <div className="yb-pours-heading">
          <div><span className="yb-kicker"><i /> FROM OUR COUNTER</span><h2>Find your<br /><em>kind of pause.</em></h2></div>
          <p>Something familiar, something new, or a little extra time together. The live menu is waiting at your table.</p>
        </div>
        <div className="yb-pour-cards">
          <article className="yb-pour-card yb-pour-card-one"><span className="yb-pour-number">01 / THE FIRST SIP</span><span className="yb-pour-illustration"><Coffee size={33} strokeWidth={1.2} /></span><h3>Wake up<br />a little slower.</h3><p>A good cup makes the morning feel like it belongs to you.</p></article>
          <article className="yb-pour-card yb-pour-card-two"><span className="yb-pour-number">02 / THE LONG PAUSE</span><span className="yb-pour-illustration"><Sparkles size={30} strokeWidth={1.2} /></span><h3>Stay for<br />one more.</h3><p>Let the conversation wander. We’ll keep the counter warm.</p></article>
          <article className="yb-pour-card yb-pour-card-three"><span className="yb-pour-number">03 / THE SHARED TABLE</span><span className="yb-pour-illustration"><Coffee size={31} strokeWidth={1.2} /></span><h3>Make room<br />for your people.</h3><p>Good coffee is even better when there’s someone across from you.</p></article>
        </div>
        <div className="yb-menu-callout"><span className="yb-menu-callout-mark"><Coffee size={20} /></span><span><b>At YB'S BREWING right now?</b><small>Scan the code on your table to see today’s menu and order at your own pace.</small></span><span className="yb-menu-callout-arrow"><ArrowRight size={18} /></span></div>
      </div>
    </section>

    <footer className="yb-footer">
      <div className="yb-shell yb-footer-inner">
        <Link to="/" className="yb-brand" aria-label="YB'S BREWING home"><span className="yb-brand-seal"><Coffee size={18} strokeWidth={1.5} /></span><span className="yb-brand-type"><b>YB'S</b><small>BREWING</small></span></Link>
        <span className="yb-footer-note">A good cup. A little more time.</span>
        <Link to="/admin/login" className="yb-footer-team">Team sign in <ArrowRight size={14} /></Link>
      </div>
    </footer>
  </main>;
}
