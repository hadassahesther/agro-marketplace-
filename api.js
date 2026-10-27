/**
 * api.js - shared across every page.
 * Wraps fetch() calls to the backend and handles the auth token + cart,
 * both kept in localStorage (this is a plain static site the browser
 * loads directly, not a hosted sandboxed artifact, so localStorage works
 * normally here).
 */
const API_BASE = "http://localhost:4000/api";

// ---------- Auth/session ----------
const Session = {
  getToken: () => localStorage.getItem("agro_token"),
  setToken: (t) => localStorage.setItem("agro_token", t),
  clear: () => {
    localStorage.removeItem("agro_token");
    localStorage.removeItem("agro_user");
  },
  getUser: () => {
    const raw = localStorage.getItem("agro_user");
    return raw ? JSON.parse(raw) : null;
  },
  setUser: (u) => localStorage.setItem("agro_user", JSON.stringify(u)),
  isLoggedIn: () => !!Session.getToken(),
};

// ---------- API client ----------
async function apiRequest(path, { method = "GET", body, isFormData = false } = {}) {
  const headers = {};
  const token = Session.getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (!isFormData && body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
  });

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* no JSON body (e.g. 204) */
  }

  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

// ---------- Cart (client-side only, per browser) ----------
const Cart = {
  get: () => JSON.parse(localStorage.getItem("agro_cart") || "[]"),
  save: (items) => localStorage.setItem("agro_cart", JSON.stringify(items)),
  add(product, quantity) {
    const items = Cart.get();
    const existing = items.find((i) => i.productId === product.id);
    if (existing) {
      existing.quantity += quantity;
    } else {
      items.push({
        productId: product.id,
        name: product.name,
        unitPrice: product.unitPrice,
        unit: product.unit,
        imageUrl: product.imageUrl,
        quantity,
      });
    }
    Cart.save(items);
  },
  updateQuantity(productId, quantity) {
    const items = Cart.get().map((i) => (i.productId === productId ? { ...i, quantity } : i));
    Cart.save(items.filter((i) => i.quantity > 0));
  },
  remove(productId) {
    Cart.save(Cart.get().filter((i) => i.productId !== productId));
  },
  clear: () => localStorage.setItem("agro_cart", "[]"),
  count: () => Cart.get().reduce((sum, i) => sum + i.quantity, 0),
  subtotal: () => Cart.get().reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
};

// ---------- Formatting ----------
function formatUSD(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}
function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
function statusLabel(status) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------- Shared header behavior ----------
function renderHeaderAuthState() {
  const actions = document.getElementById("navActions");
  if (!actions) return;
  const user = Session.getUser();
  const cartCount = Cart.count();

  actions.innerHTML = `
    <a href="cart.html" class="btn btn-outline btn-sm">Cart${cartCount ? ` (${cartCount})` : ""}</a>
    ${
      user
        ? `<a href="${user.role === "seller" ? "dashboard-seller.html" : user.role === "admin" ? "admin.html" : "dashboard-buyer.html"}" class="btn btn-outline btn-sm">${user.fullName.split(" ")[0]}'s dashboard</a>
           <button class="btn btn-primary btn-sm" id="logoutBtn">Log out</button>`
        : `<a href="login.html" class="btn btn-outline btn-sm">Log in</a>
           <a href="register.html" class="btn btn-primary btn-sm">Join free</a>`
    }
  `;
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      Session.clear();
      window.location.href = "index.html";
    });
  }
}

function requireLogin(role) {
  const user = Session.getUser();
  if (!Session.isLoggedIn() || !user) {
    window.location.href = "login.html";
    return null;
  }
  if (role && user.role !== role) {
    alert(`This page is for ${role} accounts only. You're logged in as a ${user.role}.`);
    window.location.href = "index.html";
    return null;
  }
  return user;
}

document.addEventListener("DOMContentLoaded", renderHeaderAuthState);
