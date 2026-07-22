"use client";
import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
const TOKEN_KEY = "vd_token";

type AuthState = {
  user: { user_id: string; email: string } | null;
  orgId: string;
  token: string;
  loading: boolean;
  signup: (email: string, password: string) => Promise<{ error?: string }>;
  login: (email: string, password: string) => Promise<{ error?: string }>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ user_id: string; email: string } | null>(null);
  const [orgId, setOrgId] = useState("default-org");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);

  const validateAndRestore = useCallback(async (storedToken: string) => {
    if (!storedToken || isTokenExpired(storedToken)) {
      localStorage.removeItem(TOKEN_KEY);
      setLoading(false);
      return;
    }
    try {
      const r = await fetch(`${API}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${storedToken}` },
      });
      if (r.ok) {
        const data = await r.json();
        setToken(storedToken);
        setOrgId(data.organization_id);
        setUser({ user_id: data.user_id, email: data.email });
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch {
      setToken(storedToken);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY) || "";
    validateAndRestore(stored);
  }, [validateAndRestore]);

  const signup = useCallback(async (email: string, password: string): Promise<{ error?: string }> => {
    try {
      const r = await fetch(`${API}/api/v1/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) return { error: data.detail || "Signup failed" };
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setOrgId(data.organization_id);
      setUser({ user_id: data.user_id, email: data.email });
      return {};
    } catch {
      return { error: "Network error. Check backend." };
    }
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<{ error?: string }> => {
    try {
      const r = await fetch(`${API}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) return { error: data.detail || "Login failed" };
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setOrgId(data.organization_id);
      setUser({ user_id: data.user_id, email: data.email });
      return {};
    } catch {
      return { error: "Network error. Check backend." };
    }
  }, []);

  const logout = useCallback(async () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setOrgId("default-org");
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, orgId, token, loading, signup, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
