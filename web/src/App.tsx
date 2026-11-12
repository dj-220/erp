import { useEffect, useState, type ReactElement } from "react";
import { get, onChange } from "./api";
import { AuthProvider, useAuth } from "./auth";
import { ChangePassword, Login, NoCompany } from "./pages/Account";
import { Ageing } from "./pages/Ageing";
import { Approvals } from "./pages/Approvals";
import { Bills } from "./pages/Bills";
import { Dashboard } from "./pages/Dashboard";
import { Exports } from "./pages/Exports";
import { AuditLog, Items, Parties, Payments, PurchaseOrders, PurchaseRequests, SalesInvoices, SalesOrders, StockDocuments } from "./pages/Lists";
import { Stock } from "./pages/Stock";
import { Team } from "./pages/Team";
import { InvoiceDetail, NewSalesOrder, SalesOrderDetail } from "./pages/SalesDocs";
import { NewPurchaseOrder, NewRequest, PurchaseOrderDetail, RequestDetail } from "./pages/PurchaseDocs";
import { NewBill, NewPayment, PaymentDetail } from "./pages/MoneyDocs";
import { NewStockCount, NewStockDocument, StockDocumentDetail } from "./pages/StockDocs";
import { Boms, NewBom, NewItem, NewParty } from "./pages/Masters";
import { Inventory, PlantLayout } from "./pages/Plant";
import { Page } from "./ui";

interface Route {
  path: string;
  label: string;
  group: string;
  /** The person needs any one of these. */
  needs: string[];
  /** Built from the address, so "/sales/orders/:id" can hand the id to the page. */
  element: (params: Record<string, string>) => ReactElement;
  /** Pages reached from a button or a link rather than the menu. */
  hidden?: boolean;
}

const ROUTES: Route[] = [
  { path: "/", label: "Dashboard", group: "", needs: ["dashboard.view"], element: () => <Dashboard /> },
  { path: "/sales/orders/new", label: "New sales order", group: "Sales", needs: ["sales.write"], hidden: true, element: () => <NewSalesOrder /> },
  { path: "/sales/orders/:id", label: "Sales order", group: "Sales", needs: ["sales.read"], hidden: true, element: (p) => <SalesOrderDetail id={p.id as string} /> },
  { path: "/sales/invoices/:id", label: "Invoice", group: "Sales", needs: ["sales.read"], hidden: true, element: (p) => <InvoiceDetail id={p.id as string} /> },
  { path: "/purchasing/requests/new", label: "New request", group: "Buying", needs: ["purchase.write"], hidden: true, element: () => <NewRequest /> },
  { path: "/purchasing/requests/:id", label: "Request", group: "Buying", needs: ["purchase.read"], hidden: true, element: (p) => <RequestDetail id={p.id as string} /> },
  { path: "/purchasing/orders/new", label: "New purchase order", group: "Buying", needs: ["purchase.write"], hidden: true, element: () => <NewPurchaseOrder /> },
  { path: "/purchasing/orders/:id", label: "Purchase order", group: "Buying", needs: ["purchase.read"], hidden: true, element: (p) => <PurchaseOrderDetail id={p.id as string} /> },
  { path: "/stock/movements/new", label: "New stock movement", group: "Stock", needs: ["stock.write"], hidden: true, element: () => <NewStockDocument /> },
  { path: "/stock/count", label: "Stock count", group: "Stock", needs: ["stock.write"], hidden: true, element: () => <NewStockCount /> },
  { path: "/stock/documents/:id", label: "Stock document", group: "Stock", needs: ["stock.read"], hidden: true, element: (p) => <StockDocumentDetail id={p.id as string} /> },
  { path: "/bills/new", label: "New bill", group: "Money", needs: ["bill.write"], hidden: true, element: () => <NewBill /> },
  { path: "/payments/new", label: "New payment", group: "Money", needs: ["payment.write"], hidden: true, element: () => <NewPayment /> },
  { path: "/payments/:id", label: "Payment", group: "Money", needs: ["payment.read"], hidden: true, element: (p) => <PaymentDetail id={p.id as string} /> },
  { path: "/parties/new", label: "New party", group: "Data", needs: ["party.write"], hidden: true, element: () => <NewParty /> },
  { path: "/items/new", label: "New item", group: "Data", needs: ["item.write"], hidden: true, element: () => <NewItem /> },
  { path: "/boms/new", label: "New BOM", group: "Data", needs: ["bom.write"], hidden: true, element: () => <NewBom /> },
  { path: "/boms", label: "Bills of materials", group: "Data", needs: ["master.read"], element: () => <Boms /> },
  { path: "/sales/orders", label: "Sales orders", group: "Sales", needs: ["sales.read"], element: () => <SalesOrders /> },
  { path: "/sales/invoices", label: "Invoices", group: "Sales", needs: ["sales.read"], element: () => <SalesInvoices /> },
  { path: "/purchasing/requests", label: "Requests", group: "Buying", needs: ["purchase.read"], element: () => <PurchaseRequests /> },
  { path: "/purchasing/orders", label: "Purchase orders", group: "Buying", needs: ["purchase.read"], element: () => <PurchaseOrders /> },
  { path: "/approvals", label: "Approvals", group: "Buying", needs: ["approval.view"], element: () => <Approvals /> },
  { path: "/inventory/layout", label: "Plant layout", group: "Stock", needs: ["plant.manage"], hidden: true, element: () => <PlantLayout /> },
  { path: "/inventory/:areaId", label: "Area", group: "Stock", needs: ["plant.read"], hidden: true, element: (p) => <Inventory areaId={p.areaId as string} /> },
  { path: "/inventory", label: "Inventory by area", group: "Stock", needs: ["plant.read"], element: () => <Inventory /> },
  { path: "/stock", label: "Stock", group: "Stock", needs: ["stock.read"], element: () => <Stock /> },
  { path: "/stock/movements", label: "Movements", group: "Stock", needs: ["stock.read"], element: () => <StockDocuments /> },
  { path: "/bills", label: "Supplier bills", group: "Money", needs: ["bill.read"], element: () => <Bills /> },
  { path: "/payments", label: "Payments", group: "Money", needs: ["payment.read"], element: () => <Payments /> },
  { path: "/ageing", label: "Who owes what", group: "Money", needs: ["report.money"], element: () => <Ageing /> },
  { path: "/parties", label: "Customers and suppliers", group: "Data", needs: ["master.read"], element: () => <Parties /> },
  { path: "/items", label: "Items", group: "Data", needs: ["master.read"], element: () => <Items /> },
  { path: "/exports", label: "Exports", group: "Admin", needs: ["export.excel", "export.tally"], element: () => <Exports /> },
  { path: "/audit", label: "Audit trail", group: "Admin", needs: ["audit.read"], element: () => <AuditLog /> },
  { path: "/team", label: "People and settings", group: "Admin", needs: ["member.read"], element: () => <Team /> },
];

/** Find the page for an address, and the values in it ("/sales/orders/abc" gives { id: "abc" }). */
function matchRoute(path: string): { route: Route; params: Record<string, string> } | undefined {
  const parts = path.split("/");
  for (const route of ROUTES) {
    const pattern = route.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = parts[i] as string), true) : seg === parts[i]));
    if (ok) return { route, params };
  }
  return undefined;
}

const GROUP_ORDER = ["", "Sales", "Buying", "Stock", "Money", "Data", "Admin"];

const hashPath = () => {
  const raw = window.location.hash.replace(/^#/, "").split("?")[0] ?? "";
  return raw === "" ? "/" : raw;
};

function useHashPath() {
  const [path, setPath] = useState(hashPath());
  useEffect(() => {
    const onChange = () => {
      setPath(hashPath());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}

/* ------------------------------------------------------------ Theme: follows the system until the person chooses */

type Theme = "light" | "dark";
const systemTheme = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("erp-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* storage can be blocked; fall through to the system setting */
    }
    return systemTheme();
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("erp-theme", next);
    } catch {
      /* the choice just will not be remembered */
    }
  };
  return [theme, toggle] as const;
}

/* ------------------------------------------------------------ Shell */

function Shell() {
  const { me, can, signOut, switchCompany } = useAuth();
  const path = useHashPath();
  const [theme, toggleTheme] = useTheme();
  const [waiting, setWaiting] = useState(0);
  const [changes, setChanges] = useState(0);
  const allowed = ROUTES.filter((r) => !r.hidden && r.needs.some(can));
  useEffect(() => onChange(() => setChanges((n) => n + 1)), []);

  // The number on "Approvals" is how many orders are waiting on this person.
  useEffect(() => {
    if (!can("approval.view")) return;
    let live = true;
    get<{ canDecide?: boolean }[]>("/api/approvals/pending").then(
      (rows) => live && setWaiting(rows.filter((r) => r.canDecide).length),
      () => live && setWaiting(0),
    );
    return () => {
      live = false;
    };
  }, [path, me?.companyId, can, changes]);

  if (!me) return null;
  const found = path === "/password" ? undefined : matchRoute(path);
  const current = found?.route;
  // The menu entry that owns this page: the longest one whose address starts the current address.
  const activePath = allowed.map((r) => r.path).filter((p) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`))).sort((x, y) => y.length - x.length)[0];
  const groups = [...new Set(allowed.map((r) => r.group))].sort((x, y) => GROUP_ORDER.indexOf(x) - GROUP_ORDER.indexOf(y));
  const company = me.companies.find((c) => c.companyId === me.companyId);

  let content: ReactElement;
  if (path === "/password") content = <ChangePassword />;
  else if (!current) content = <Page title="Page not found"><p>There is nothing at this address. <a href="#/">Go to the dashboard</a>.</p></Page>;
  else if (!current.needs.some(can)) content = <Page title="No access"><p>Your role ({me.role}) cannot open this page. <a href="#/">Go to the dashboard</a>.</p></Page>;
  else content = current.element(found?.params ?? {});

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32"><path d="M9 22V10h10M9 16h8M9 22h10" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" /></svg>
          </span>
          ERP
        </div>
        <div className="co">
          <strong>{company?.companyName ?? "No company"}</strong>
          {me.companies.length > 1 ? (
            <select aria-label="Switch company" value={me.companyId ?? ""} onChange={(e) => { window.location.hash = "#/"; void switchCompany(e.target.value); }}>
              {me.companies.map((c) => <option key={c.companyId} value={c.companyId}>{c.companyName} ({c.role})</option>)}
            </select>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>You are {me.role}</span>
          )}
        </div>
        <nav className="nav" aria-label="Main">
          {groups.map((group) => (
            <div key={group || "top"}>
              {group ? <div className="nav-group">{group}</div> : null}
              {allowed.filter((r) => r.group === group).map((r) => (
                <a key={r.path} href={`#${r.path}`} aria-current={r.path === activePath ? "page" : undefined}>
                  {r.label}
                  {r.path === "/approvals" && waiting > 0 ? <span className="badge" aria-label={`${waiting} waiting for you`}>{waiting}</span> : null}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="who"><b>{me.user.name}</b>{me.user.email}</div>
          <div className="actions">
            <button className="btn small" onClick={toggleTheme} aria-pressed={theme === "dark"}>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
            <a className="btn small" href="#/password" aria-current={path === "/password" ? "page" : undefined}>Password</a>
            <button className="btn small" onClick={() => void signOut()}>Sign out</button>
          </div>
        </div>
      </aside>
      <main className="main" key={`${me.companyId}:${path}`}>{content}</main>
    </div>
  );
}

function Gate() {
  const { me, loading } = useAuth();
  if (loading) return <p className="muted" role="status" style={{ padding: 24 }}>Loading…</p>;
  if (!me) return <Login />;
  if (me.user.mustChangePassword || me.mustChangePassword) return <ChangePassword forced />;
  if (!me.companyId) return <NoCompany />;
  return <Shell />;
}

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
