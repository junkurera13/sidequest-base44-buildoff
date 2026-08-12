import type { Metadata } from "next";
import {
  DM_Sans,
  Instrument_Sans,
  Newsreader,
} from "next/font/google";
import "./globals.css";

const chapterSans = DM_Sans({
  variable: "--font-chapter-sans",
  subsets: ["latin"],
});

const chapterSerif = Newsreader({
  variable: "--font-chapter-serif",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const chapterInstrument = Instrument_Sans({
  variable: "--font-chapter-instrument",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Chapter Buildoff",
  description:
    "Experiences that feel strangely meant for you.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${chapterSans.variable} ${chapterSerif.variable} ${chapterInstrument.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-white font-[family-name:var(--font-chapter-sans)] text-[#1c1c19]">
        {children}
      </body>
    </html>
  );
}
