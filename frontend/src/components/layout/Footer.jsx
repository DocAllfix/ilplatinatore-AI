import React from "react";
import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <footer className="border-t border-white/5 bg-platinum-void">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="md:col-span-2">
            <span className="text-xl font-bold text-foreground">🎮 Il Platinatore AI</span>
            <p className="mt-3 text-sm text-muted-foreground max-w-sm leading-relaxed">
              L'assistente AI che genera guide personalizzate per trofei e achievement di qualsiasi videogioco.
            </p>
            <a
              href="https://ilplatinatore.it"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-3 text-sm text-secondary hover:text-secondary/80 transition-colors"
            >
              ilplatinatore.it →
            </a>
          </div>

          {/* Links */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-4">Navigazione</h4>
            <ul className="space-y-2">
              {[
                { label: "Chat", path: "/chat" },
                { label: "Prezzi", path: "/prezzi" },
                { label: "Chi Siamo", path: "/chi-siamo" },
                { label: "Profilo", path: "/profilo" },
              ].map((link) => (
                <li key={link.path}>
                  <Link
                    to={link.path}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal + Social */}
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-4">Legale</h4>
            <ul className="space-y-2">
              <li><span className="text-sm text-muted-foreground">Privacy Policy</span></li>
              <li><span className="text-sm text-muted-foreground">Termini di Servizio</span></li>
              <li><span className="text-sm text-muted-foreground">Contatti</span></li>
            </ul>
            <div className="mt-6 flex gap-4">
              {["YouTube", "TikTok", "Instagram", "Discord"].map((social) => (
                <span
                  key={social}
                  className="text-xs text-muted-foreground hover:text-secondary transition-colors cursor-pointer"
                >
                  {social}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-white/5 text-center">
          <p className="text-xs text-muted-foreground">
            © 2026 Il Platinatore. Tutti i diritti riservati.
          </p>
        </div>
      </div>
    </footer>
  );
}