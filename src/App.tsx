import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Landing } from "./shared/Landing";

const CustomerMenu = lazy(() => import("./customer/Customer").then((module) => ({ default: module.CustomerMenu })));
const OrderTracking = lazy(() => import("./customer/Customer").then((module) => ({ default: module.OrderTracking })));
const AdminShell = lazy(() => import("./admin/Admin").then((module) => ({ default: module.AdminShell })));
const AdminLogin = lazy(() => import("./admin/Admin").then((module) => ({ default: module.AdminLogin })));
const AdminSetup = lazy(() => import("./admin/Admin").then((module) => ({ default: module.AdminSetup })));
const adminLoading = <div className="customer-loading"><span className="loader" /><p>Loading your cafe workspace…</p></div>;

export default function App() {
  return <Routes>
    <Route path="/" element={<Landing />} />
    <Route path="/c/:qrToken" element={<Suspense fallback={adminLoading}><CustomerMenu /></Suspense>} />
    <Route path="/order/:trackingToken" element={<Suspense fallback={adminLoading}><OrderTracking /></Suspense>} />
    <Route path="/admin/login" element={<Suspense fallback={adminLoading}><AdminLogin /></Suspense>} />
    <Route path="/admin/setup" element={<Suspense fallback={adminLoading}><AdminSetup /></Suspense>} />
    <Route path="/admin/*" element={<Suspense fallback={adminLoading}><AdminShell /></Suspense>} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
