import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, get, post, setUnauthorizedHandler } from "./api";

export interface Me {
  user: { id: string; email: string; name: string; mustChangePassword: boolean };
  companyId: string | null;
  role: string | null;
  approvalLimitPaise: number;
  companies: { companyId: string; companyName: string; role: string }[];
  permissions: string[];
  mustChangePassword?: boolean;
}

interface AuthState {
  me: Me | null;
  /** True until we know whether anyone is signed in. */
  loading: boolean;
  can: (action: string) => boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  switchCompany: (companyId: string) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await get<Me>("/api/auth/me"));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    refresh().catch(() => setLoading(false));
    return () => setUnauthorizedHandler(null);
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      can: (action) => me?.permissions.includes(action) ?? false,
      refresh,
      signIn: async (email, password) => {
        setMe(await post<Me>("/api/auth/login", { email, password }));
      },
      signOut: async () => {
        await post("/api/auth/logout").catch(() => undefined);
        setMe(null);
      },
      switchCompany: async (companyId) => {
        setMe(await post<Me>("/api/auth/switch-company", { companyId }));
      },
    }),
    [me, loading, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(Ctx);
  if (!value) throw new Error("useAuth outside AuthProvider");
  return value;
}
