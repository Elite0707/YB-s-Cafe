export type Cafe = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  logoUrl?: string | null;
  accentColor?: string;
  currency: string;
  taxBps: number;
  onlinePaymentsEnabled?: boolean;
};

export type Choice = { id: string; label: string; priceDeltaCents: number };
export type OptionGroup = { id: string; label: string; required: boolean; choices: Choice[] };
export type Category = { id: string; name: string; description?: string };
export type MenuItem = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  imageUrl?: string | null;
  priceCents: number;
  available: boolean;
  prepMinutes?: number;
  isVegetarian?: boolean;
  isVegan?: boolean;
  allergens?: string[];
  options?: OptionGroup[];
};
export type PublicMenu = { cafe: Cafe; table: { id: string; name: string }; categories: Category[]; items: MenuItem[] };
export type OrderLine = { id?: string; itemId?: string; name: string; quantity: number; unitPriceCents?: number; priceCents?: number; lineTotalCents?: number; options?: { label: string; priceDeltaCents?: number }[]; selectedOptions?: { label: string; choiceLabel?: string; priceDeltaCents?: number }[]; notes?: string; specialInstructions?: string };
export type Order = {
  id: string;
  orderNumber: string | number;
  status: string;
  paymentStatus: string;
  paymentMethod?: string;
  totalCents: number;
  createdAt: string;
  table?: { name?: string; label?: string };
  tableName?: string;
  cafeName?: string;
  currency?: string;
  menuPath?: string;
  estimatedMinutes?: number;
  items: OrderLine[];
};
export type AdminSession = { admin: { id: string; name?: string; email: string }; cafe: Cafe };

export function formatMoney(cents: number, currency = "INR") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
}

export function statusTone(status: string) {
  const value = status.toLowerCase();
  if (["completed", "served", "paid", "ready"].includes(value)) return "success";
  if (["preparing", "pending", "unpaid", "confirmed"].includes(value)) return "warm";
  if (["cancelled", "failed", "refunded", "rejected"].includes(value)) return "danger";
  return "neutral";
}
