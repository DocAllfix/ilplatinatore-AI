// @ts-nocheck
import { useState } from "react";
import { motion } from "framer-motion";
import { Link, useNavigate, Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { UserPlus, Mail, Lock, User, AlertCircle, CheckCircle } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

function PasswordStrength({ password }) {
  const checks = [
    { label: "8+ caratteri", ok: password.length >= 8 },
    { label: "Lettera maiuscola", ok: /[A-Z]/.test(password) },
    { label: "Numero", ok: /\d/.test(password) },
  ];
  if (!password) return null;
  return (
    <div className="flex gap-3 mt-1.5">
      {checks.map((c) => (
        <span
          key={c.label}
          className={`flex items-center gap-1 text-xs ${c.ok ? "text-secondary" : "text-muted-foreground/40"}`}
        >
          <CheckCircle className={`w-3 h-3 ${c.ok ? "text-secondary" : "text-muted-foreground/20"}`} />
          {c.label}
        </span>
      ))}
    </div>
  );
}

export default function Register() {
  const navigate = useNavigate();
  const { register, isAuthenticated, isLoadingAuth } = useAuth();

  // Tutti gli hook PRIMA di qualsiasi return condizionale (regola degli hook)
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Se già autenticato, redirige direttamente alla chat
  if (!isLoadingAuth && isAuthenticated) {
    return <Navigate to="/chat" replace />;
  }

  const isValid = name.trim().length >= 2 && email.includes("@") && password.length >= 8;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isValid) return;
    setLoading(true);
    setError(null);
    try {
      await register(email, password, name.trim());
      navigate("/chat");
    } catch (err) {
      const msg = err?.data?.error || err?.data?.message || "Registrazione non riuscita. Riprova.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4 py-12"
    >
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/20 border border-primary/30 mb-4">
            <UserPlus className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Crea il tuo account</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Guide illimitate ti aspettano
          </p>
        </div>

        {/* Card */}
        <div className="glass-card rounded-2xl border border-white/5 p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Name */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Nome
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Il tuo nome"
                  required
                  minLength={2}
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50 transition-colors"
                />
              </div>
            </div>

            {/* Email */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@esempio.com"
                  required
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50 transition-colors"
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimo 8 caratteri"
                  required
                  minLength={8}
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50 transition-colors"
                />
              </div>
              <PasswordStrength password={password} />
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {/* Submit */}
            <Button
              type="submit"
              disabled={loading || !isValid}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl py-6 text-base font-semibold glow-purple disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                  Registrazione in corso...
                </span>
              ) : (
                "Crea account"
              )}
            </Button>

            <p className="text-xs text-center text-muted-foreground/50 leading-relaxed">
              Registrandoti accetti i{" "}
              <a href="https://www.ilplatinatore.it" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary transition-colors">
                Termini di Servizio
              </a>{" "}
              e la{" "}
              <a href="https://www.ilplatinatore.it" target="_blank" rel="noopener noreferrer" className="text-primary/70 hover:text-primary transition-colors">
                Privacy Policy
              </a>
            </p>
          </form>

          <div className="mt-6 pt-6 border-t border-white/5 text-center">
            <p className="text-sm text-muted-foreground">
              Hai già un account?{" "}
              <Link
                to="/login"
                className="text-primary hover:text-primary/80 font-medium transition-colors"
              >
                Accedi
              </Link>
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
