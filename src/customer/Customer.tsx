import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, Clock3, Leaf, Minus, Plus, Search, ShoppingBag, ShoppingBasket, Sparkles, X } from "lucide-react";
import { api, friendlyError, jsonBody } from "../api";
import { Cafe, formatMoney, MenuItem, Order, OptionGroup, PublicMenu } from "../types";
import { ThemeToggle } from "../shared/ThemeToggle";

type CartLine = { key: string; itemId: string; quantity: number; optionChoiceIds: string[]; notes: string };
const cartKey = (token: string) => `tablefolk-cart-${token}`;
const orderHistoryKey = (token: string) => `tablefolk-order-tokens-${token}`;
const lineKey = (itemId: string, choiceIds: string[], notes: string) => `${itemId}:${[...choiceIds].sort().join(",")}:${notes.trim()}`;
const readCart = (token: string): CartLine[] => {
  try { return JSON.parse(localStorage.getItem(cartKey(token)) || "[]") as CartLine[]; } catch { return []; }
};
const readOrderTokens = (token: string): string[] => {
  try { const value = JSON.parse(localStorage.getItem(orderHistoryKey(token)) || "[]"); return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 5) : []; } catch { return []; }
};
function rememberOrderToken(tableToken: string, trackingToken: string) {
  const tokens = [trackingToken, ...readOrderTokens(tableToken).filter((entry) => entry !== trackingToken)].slice(0, 5);
  localStorage.setItem(orderHistoryKey(tableToken), JSON.stringify(tokens));
}

export function CustomerMenu() {
  const { qrToken = "" } = useParams();
  const navigate = useNavigate();
  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [cart, setCart] = useState<CartLine[]>(() => readCart(qrToken));
  const [recentOrders, setRecentOrders] = useState<{ token: string; order: Order }[]>([]);
  const [activeCategory, setActiveCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkout, setCheckout] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"CASH_COUNTER" | "CASH_TABLE" | "ONLINE">("CASH_COUNTER");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<PublicMenu>(`/api/public/tables/${encodeURIComponent(qrToken)}`)
      .then((data) => { if (alive) { setMenu(data); setError(""); } })
      .catch((reason) => { if (alive) setError(friendlyError(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [qrToken]);
  useEffect(() => { localStorage.setItem(cartKey(qrToken), JSON.stringify(cart)); }, [qrToken, cart]);
  useEffect(() => {
    let alive = true;
    const tokens = readOrderTokens(qrToken);
    Promise.all(tokens.map(async (token) => {
      try { const value = await api<{ order: Order }>(`/api/public/orders/${encodeURIComponent(token)}`); return { token, order: value.order }; }
      catch { return null; }
    })).then((orders) => { if (alive) setRecentOrders(orders.filter((entry): entry is { token: string; order: Order } => !!entry)); });
    return () => { alive = false; };
  }, [qrToken]);
  useEffect(() => { if (menu && !menu.cafe.onlinePaymentsEnabled && paymentMethod === "ONLINE") setPaymentMethod("CASH_COUNTER"); }, [menu, paymentMethod]);

  const filteredItems = useMemo(() => (menu?.items ?? []).filter((item) =>
    (activeCategory === "all" || item.categoryId === activeCategory) &&
    (!search || `${item.name} ${item.description} ${(item.allergens ?? []).join(" ")}`.toLowerCase().includes(search.toLowerCase()))), [menu, activeCategory, search]);
  const itemById = useMemo(() => new Map((menu?.items ?? []).map((item) => [item.id, item])), [menu]);
  const count = cart.reduce((sum, line) => sum + line.quantity, 0);
  const subtotalCents = cart.reduce((sum, line) => {
    const item = itemById.get(line.itemId);
    const optionCents = (item?.options ?? []).flatMap((group) => group.choices).filter((choice) => line.optionChoiceIds.includes(choice.id)).reduce((total, choice) => total + choice.priceDeltaCents, 0);
    return sum + ((item?.priceCents ?? 0) + optionCents) * line.quantity;
  }, 0);
  const taxCents = Math.round(subtotalCents * ((menu?.cafe.taxBps ?? 0) / 10000));
  const totalCents = subtotalCents + taxCents;

  function changeQuantity(key: string, change: number) {
    setCart((previous) => previous.map((line) => line.key === key ? { ...line, quantity: line.quantity + change } : line).filter((line) => line.quantity > 0));
  }
  function addToCart(item: MenuItem, optionChoiceIds: string[] = [], notes = "") {
    const key = lineKey(item.id, optionChoiceIds, notes);
    setCart((previous) => {
      const existing = previous.find((line) => line.key === key);
      return existing ? previous.map((line) => line.key === key ? { ...line, quantity: line.quantity + 1 } : line) : [...previous, { key, itemId: item.id, quantity: 1, optionChoiceIds, notes }];
    });
    setSelectedItem(null);
    setNotice(`${item.name} added to your bag`);
    window.setTimeout(() => setNotice(""), 2400);
  }

  async function submitOrder(event: FormEvent) {
    event.preventDefault();
    if (!menu || !cart.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const idempotencyKey = crypto.randomUUID();
      const result = await api<{ order: Order; trackingToken: string; checkoutUrl?: string }>("/api/public/orders", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: jsonBody({ qrToken, items: cart.map((line) => { const item = itemById.get(line.itemId); return { itemId: line.itemId, quantity: line.quantity, options: (item?.options ?? []).flatMap((group) => group.choices.filter((choice) => line.optionChoiceIds.includes(choice.id)).map((choice) => ({ optionId: group.id, choiceId: choice.id }))), specialInstructions: line.notes }; }), paymentMethod }),
      });
      rememberOrderToken(qrToken, result.trackingToken);
      setRecentOrders((orders) => [{ token: result.trackingToken, order: result.order }, ...orders.filter((entry) => entry.order.id !== result.order.id)].slice(0, 5));
      localStorage.removeItem(cartKey(qrToken));
      if (result.checkoutUrl) { window.location.assign(result.checkoutUrl); return; }
      navigate(`/order/${encodeURIComponent(result.trackingToken)}`, { state: { cafe: menu.cafe, tableName: menu.table.name } });
    } catch (reason) { setError(friendlyError(reason)); setBusy(false); }
  }

  if (loading) return <div className="customer-loading"><span className="loader" /><p>Setting your table…</p></div>;
  if (error && !menu) return <main className="customer-error"><span className="error-icon">!</span><h1>We couldn't find this table</h1><p>{error}</p><button className="button button-dark" onClick={() => window.location.reload()}>Try again</button><LinkToHome /></main>;
  if (!menu) return null;
  const { cafe, table, categories } = menu;

  return <main className="customer-page" style={{ "--cafe-accent": cafe.accentColor || "#597958" } as React.CSSProperties}>
    <header className="customer-header"><div className="cafe-brand">{cafe.logoUrl ? <img src={cafe.logoUrl} alt="" /> : <span className="cafe-monogram">{cafe.name.slice(0, 1)}</span>}<span className="cafe-name">{cafe.name}</span></div><div className="customer-header-actions"><ThemeToggle /><span className="table-pill"><span className="table-pill-dot" /> {table.name}</span></div></header>
    <section className="customer-welcome"><div className="customer-welcome-copy"><span className="eyebrow eyebrow-green">YOUR TABLE IS READY</span><h1>Good food.<br /><em>Good company.</em></h1><p>{cafe.description || "Browse the menu, make it your own, and order from your table."}</p></div><div className="welcome-illustration" aria-hidden="true"><div className="welcome-stem" /><div className="welcome-leaf" /><div className="welcome-cup"><div /></div><div className="welcome-saucer" /></div></section>
    <section className="menu-intro"><div><span className="eyebrow eyebrow-muted">THE MENU</span><h2>Find your <em>favorite.</em></h2></div><div className="menu-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search menu" placeholder="Coffee, something sweet…" /><kbd>⌘ K</kbd></div></section>
    <nav className="category-nav" aria-label="Menu categories"><button className={activeCategory === "all" ? "category-chip active" : "category-chip"} onClick={() => setActiveCategory("all")}>Everything</button>{categories.map((category) => <button key={category.id} className={activeCategory === category.id ? "category-chip active" : "category-chip"} onClick={() => setActiveCategory(category.id)}>{category.name}</button>)}</nav>
    {filteredItems.length ? <section className="menu-grid" aria-live="polite">{filteredItems.map((item) => <MenuCard key={item.id} item={item} currency={cafe.currency} onSelect={() => item.available && setSelectedItem(item)} />)}</section> : <div className="empty-menu"><span><ShoppingBasket size={24} /></span><h3>No matches just yet</h3><p>Try another search or choose a different category.</p><button className="text-button" onClick={() => { setSearch(""); setActiveCategory("all"); }}>Show the whole menu <ArrowRight size={14} /></button></div>}
    {recentOrders.length > 0 && <section className="customer-history"><div className="customer-history-heading"><span><span className="eyebrow eyebrow-muted">FROM THIS TABLE</span><h2>Your recent <em>orders.</em></h2></span><span>Only you can see this on this device</span></div><div className="customer-history-list">{recentOrders.map(({ token, order }) => <Link className="customer-history-row" key={order.id} to={`/order/${encodeURIComponent(token)}`}><span className="history-order-mark"><ShoppingBag size={15} /></span><span className="history-order-copy"><b>Order #{order.orderNumber}</b><small>{new Date(order.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {order.items.reduce((sum, item) => sum + item.quantity, 0)} item{order.items.reduce((sum, item) => sum + item.quantity, 0) === 1 ? "" : "s"}</small></span><span className={`status-badge tone-${order.status.toLowerCase() === "ready" || order.status.toLowerCase() === "completed" ? "success" : order.status.toLowerCase() === "cancelled" ? "danger" : "warm"}`}>{order.status.toLowerCase()}</span><ArrowRight size={15} /></Link>)}</div></section>}
    <footer className="customer-footer"><span>Made with care at <b>{cafe.name}</b></span><span>Thanks for stopping by.</span></footer>
    {count > 0 && <button className="sticky-cart" onClick={() => { setCartOpen(true); setCheckout(false); }}><span className="sticky-cart-count">{count}</span><span>Review your order</span><b>{formatMoney(totalCents, cafe.currency)}</b><ArrowRight size={16} /></button>}
    {selectedItem && <ItemModal item={selectedItem} currency={cafe.currency} onClose={() => setSelectedItem(null)} onAdd={addToCart} />}
    {cartOpen && <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setCartOpen(false)}><aside className="cart-sheet" role="dialog" aria-modal="true" aria-label={checkout ? "Checkout" : "Your order"}>
      <div className="sheet-head"><button className="icon-button" aria-label="Close" onClick={() => setCartOpen(false)}><X size={20} /></button><div><span className="eyebrow eyebrow-muted">{checkout ? "ONE LAST THING" : table.name}</span><h2>{checkout ? "Let's make it yours." : "Your order"}</h2></div><span className="bag-small"><ShoppingBag size={18} /> {count}</span></div>
      {!checkout ? <><div className="cart-lines">{cart.map((line) => {
        const item = itemById.get(line.itemId); if (!item) return null;
        const selected = (item.options ?? []).flatMap((group) => group.choices).filter((choice) => line.optionChoiceIds.includes(choice.id));
        const unit = item.priceCents + selected.reduce((sum, choice) => sum + choice.priceDeltaCents, 0);
        return <div className="cart-line" key={line.key}><div className="cart-line-main"><b>{item.name}</b><small>{selected.map((choice) => choice.label).join(" · ") || "Made fresh for you"}{line.notes ? ` · ${line.notes}` : ""}</small><div className="quantity-control"><button aria-label={`Remove one ${item.name}`} onClick={() => changeQuantity(line.key, -1)}><Minus size={13} /></button><span>{line.quantity}</span><button aria-label={`Add one ${item.name}`} onClick={() => changeQuantity(line.key, 1)}><Plus size={13} /></button></div></div><strong>{formatMoney(unit * line.quantity, cafe.currency)}</strong></div>;
      })}</div><div className="cart-bottom"><div className="cart-summary-row"><span>Subtotal</span><b>{formatMoney(subtotalCents, cafe.currency)}</b></div><div className="cart-summary-row"><span>Tax</span><b>{formatMoney(taxCents, cafe.currency)}</b></div><div className="cart-summary-row cart-total"><span>Total</span><b>{formatMoney(totalCents, cafe.currency)}</b></div>{error && <p className="inline-error" role="alert">{error}</p>}<button className="button button-dark button-full" onClick={() => setCheckout(true)}>Continue to checkout <ArrowRight size={16} /></button><p className="secure-note"><Sparkles size={13} /> Your table, your pace. No account needed.</p></div></> : <form className="checkout-form" onSubmit={submitOrder}><button type="button" className="back-link" onClick={() => setCheckout(false)}><ArrowLeft size={15} /> Back to order</button><div className="checkout-total"><span>Your total</span><b>{formatMoney(totalCents, cafe.currency)}</b></div><fieldset className="payment-options"><legend>How would you like to pay?</legend><label className={paymentMethod === "CASH_COUNTER" ? "payment-choice selected" : "payment-choice"}><input type="radio" name="payment" value="CASH_COUNTER" checked={paymentMethod === "CASH_COUNTER"} onChange={() => setPaymentMethod("CASH_COUNTER")} /><span className="payment-choice-icon">◉</span><span><b>At the counter</b><small>Pay when you’re ready to leave</small></span><span className="radio-dot" /></label><label className={paymentMethod === "CASH_TABLE" ? "payment-choice selected" : "payment-choice"}><input type="radio" name="payment" value="CASH_TABLE" checked={paymentMethod === "CASH_TABLE"} onChange={() => setPaymentMethod("CASH_TABLE")} /><span className="payment-choice-icon">⌂</span><span><b>At my table</b><small>We’ll bring the bill to you</small></span><span className="radio-dot" /></label>{cafe.onlinePaymentsEnabled && <label className={paymentMethod === "ONLINE" ? "payment-choice selected" : "payment-choice"}><input type="radio" name="payment" value="ONLINE" checked={paymentMethod === "ONLINE"} onChange={() => setPaymentMethod("ONLINE")} /><span className="payment-choice-icon">▤</span><span><b>Pay online</b><small>Secure card checkout</small></span><span className="radio-dot" /></label>}</fieldset>{error && <p className="inline-error" role="alert">{error}</p>}<button className="button button-dark button-full" disabled={busy}>{busy ? <><span className="button-spinner" /> Sending your order…</> : <>Place order <ArrowRight size={16} /></>}</button><p className="secure-note"><Sparkles size={13} /> Your order is confirmed once it reaches the cafe.</p></form>}
    </aside></div>}
    {notice && <div role="status" className="toast"><Check size={16} /> {notice}</div>}
  </main>;
}

function LinkToHome() { return <a href="/">Return home</a>; }

function MenuCard({ item, currency, onSelect }: { item: MenuItem; currency: string; onSelect: () => void }) {
  return <article className={item.available ? "menu-card" : "menu-card unavailable"}>
    <button className="menu-card-image" onClick={onSelect} disabled={!item.available} aria-label={`View ${item.name}`}>
      {item.imageUrl ? <img src={item.imageUrl} alt={item.name} loading="lazy" /> : <div className="food-placeholder"><span>{item.name.slice(0, 1)}</span></div>}
      {!item.available && <span className="unavailable-label">Taking a little break</span>}
      <span className="card-add"><Plus size={17} /></span>
    </button>
    <div className="menu-card-copy"><div className="menu-item-title"><h3>{item.name}</h3>{item.isVegan ? <span className="diet-tag"><Leaf size={12} /> Vegan</span> : item.isVegetarian ? <span className="diet-tag"><Leaf size={12} /> Veg</span> : null}</div><p>{item.description}</p><div className="menu-card-meta"><b>{formatMoney(item.priceCents, currency)}</b>{item.prepMinutes ? <span><Clock3 size={12} /> {item.prepMinutes} min</span> : null}</div></div>
  </article>;
}

function ItemModal({ item, currency, onClose, onAdd }: { item: MenuItem; currency: string; onClose: () => void; onAdd: (item: MenuItem, choiceIds: string[], notes: string) => void }) {
  const [choiceIds, setChoiceIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [validation, setValidation] = useState("");
  const selectedAddOn = (item.options ?? []).flatMap((group) => group.choices).filter((choice) => choiceIds.includes(choice.id)).reduce((sum, choice) => sum + choice.priceDeltaCents, 0);
  function toggle(group: OptionGroup, choiceId: string) {
    setChoiceIds((ids) => [...ids.filter((id) => !group.choices.some((choice) => choice.id === id)), choiceId]);
    setValidation("");
  }
  function add() {
    const missing = (item.options ?? []).some((group) => group.required && !group.choices.some((choice) => choiceIds.includes(choice.id)));
    if (missing) { setValidation("Choose one option to continue."); return; }
    onAdd(item, choiceIds, notes);
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="item-modal" role="dialog" aria-modal="true" aria-labelledby="item-modal-title">
    <button className="modal-close icon-button" onClick={onClose} aria-label="Close item details"><X size={20} /></button>
    <div className="modal-photo">{item.imageUrl ? <img src={item.imageUrl} alt={item.name} /> : <div className="food-placeholder food-placeholder-large"><span>{item.name.slice(0, 1)}</span></div>}</div>
    <div className="modal-content"><div className="modal-heading"><div><span className="eyebrow eyebrow-muted">MADE TO ORDER</span><h2 id="item-modal-title">{item.name}</h2></div><b>{formatMoney(item.priceCents + selectedAddOn, currency)}</b></div><p className="modal-description">{item.description}</p>{item.allergens?.length ? <p className="allergen-note">Contains: {item.allergens.join(", ")}</p> : null}
      {(item.options ?? []).map((group) => <fieldset className="option-group" key={group.id}><legend>{group.label}<span>{group.required ? "Choose one" : "Optional · one choice"}</span></legend>{group.choices.map((choice) => <label key={choice.id} className="option-choice"><span><b>{choice.label}</b>{choice.priceDeltaCents > 0 && <small>+ {formatMoney(choice.priceDeltaCents, currency)}</small>}</span><input type="radio" name={`choice-${item.id}-${group.id}`} checked={choiceIds.includes(choice.id)} onChange={() => toggle(group, choice.id)} aria-label={`${choice.label}${choice.priceDeltaCents ? ` plus ${formatMoney(choice.priceDeltaCents, currency)}` : ""}`} /><span className="custom-check"><Check size={12} /></span></label>)}</fieldset>)}
      <label className="field-label">A note for the barista <span>Optional</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Oat milk, extra hot, no rush…" maxLength={180} /></label>{validation && <p role="alert" className="inline-error">{validation}</p>}<button className="button button-dark button-full" onClick={add}>Add to my order <span>{formatMoney(item.priceCents + selectedAddOn, currency)}</span></button></div>
  </section></div>;
}

export function OrderTracking() {
  const { trackingToken = "" } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [cafe, setCafe] = useState<Cafe | null>(null);
  const [tableName, setTableName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ order: Order; cafe?: Cafe; tableName?: string }>(`/api/public/orders/${encodeURIComponent(trackingToken)}`).then((data) => { if (alive) { const currentOrder = data.order; setOrder(currentOrder); if (data.cafe) setCafe(data.cafe); if (currentOrder?.tableName) setTableName(currentOrder.tableName); if (currentOrder?.currency) setCafe((previous) => previous ?? ({ id: "", name: currentOrder.cafeName || "", slug: "", currency: currentOrder.currency || "INR", taxBps: 0 })); setError(""); } }).catch((reason) => { if (alive) setError(friendlyError(reason)); }).finally(() => { if (alive) setLoading(false); });
    void load();
    const poll = window.setInterval(() => { void load(); }, 7000);
    return () => { alive = false; window.clearInterval(poll); };
  }, [trackingToken]);
  if (loading) return <div className="customer-loading"><span className="loader" /><p>Finding your order…</p></div>;
  if (error && !order) return <main className="order-state-page"><div className="order-state-card"><span className="status-emblem">?</span><h1>We can’t find that order</h1><p>{error}</p><a className="button button-dark" href="/">Back to cafe home</a></div></main>;
  if (!order) return null;
  const stages = ["PENDING", "CONFIRMED", "PREPARING", "READY", "SERVED", "COMPLETED"];
  const currentIndex = stages.indexOf(order.status.toUpperCase());
  const cancelled = order.status.toUpperCase() === "CANCELLED";
  const stageLabels = ["Order received", "Confirmed", "Being prepared", "Ready to enjoy", "Served", "All yours"];
  return <main className="order-state-page"><div className="order-state-card">
    <div className="order-state-top"><Link className="back-link" to={order.menuPath || "/"}> <ArrowLeft size={15} /> Back to menu</Link><ThemeToggle /></div>
    <div className={cancelled ? "status-emblem status-cancelled" : "status-emblem"}>{cancelled ? "×" : currentIndex >= 3 ? "✓" : <span className="pulse-dot" />}</div>
    <span className="eyebrow eyebrow-green">{cafe?.name || "YOUR CAFE"}{tableName ? ` · ${tableName}` : ""}</span><h1>{cancelled ? "This order was cancelled" : order.status === "READY" ? "A little something is ready." : order.status === "COMPLETED" ? "Hope you enjoyed it." : "Your order is in good hands."}</h1><p className="order-state-subtitle">{cancelled ? "Please ask a team member if you need help." : order.status === "PREPARING" ? "The team is making everything fresh for you." : "We’ll keep this page up to date for you."}</p>
    <div className="order-reference"><span>ORDER NUMBER</span><b>#{order.orderNumber}</b><small>{new Date(order.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></div>
    {!cancelled && <div className="order-progress">{stageLabels.map((label, index) => <div className={`progress-step ${currentIndex >= index ? "complete" : ""} ${currentIndex === index ? "current" : ""}`} key={label}><span className="progress-mark">{currentIndex > index ? <Check size={12} /> : index + 1}</span><span>{label}</span></div>)}</div>}
    <div className="order-receipt"><div className="receipt-head"><b>Your order</b><span className={`status-badge ${order.paymentStatus.toLowerCase()}`}>{order.paymentStatus.replaceAll("_", " ")}</span></div>{order.items.map((line, index) => <div className="receipt-line" key={line.id || `${line.name}-${index}`}><span><b>{line.quantity}×</b> {line.name}{line.selectedOptions?.map((option, optionIndex) => <small key={optionIndex}>{option.choiceLabel || option.label}</small>)}{line.specialInstructions && <small>{line.specialInstructions}</small>}</span><b>{formatMoney(line.lineTotalCents ?? ((line.unitPriceCents ?? line.priceCents ?? 0) * line.quantity), cafe?.currency ?? order.currency)}</b></div>)}<div className="receipt-total"><span>Total</span><b>{formatMoney(order.totalCents, cafe?.currency ?? order.currency)}</b></div></div>
    <p className="live-note"><span className="live-dot" /> This page updates as your order moves along</p>
  </div></main>;
}
