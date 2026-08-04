"use client";

import { ThemeProvider } from "next-themes";
import { MotionRoot } from "@/components/motion/motion-root";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <MotionRoot>{children}</MotionRoot>
    </ThemeProvider>
  );
}
