"use client";
import { ReactNode } from "react";
import { AuthProvider } from "@/lib/AuthContext";

export default function Providers({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
