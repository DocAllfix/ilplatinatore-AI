import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, User, Mail, Lock, Gamepad2, Bell, Save, Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";
import { patchMe, uploadAvatar } from "@/api/stubs";

const PLATFORMS = ["PlayStation", "Xbox", "Nintendo Switch", "PC (Steam)", "PC (Epic)", "Mobile"];

export default function ProfileSettings() {
  const { user, navigateToLogin } = useAuth();
  const [form, setForm] = useState({
    full_name: "",
    username: "",
    birth_date: "",
    email: "",
    platform: "",
    notifications: true,
  });
  const [saved, setSaved] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!user) return;
    setAvatarUrl(user.avatar_url || null);
    setForm({
      full_name: user.displayName || user.full_name || "",
      username: user.username || "",
      birth_date: user.birth_date || "",
      email: user.email || "",
      platform: user.platform || "",
      notifications: user.notifications !== false,
    });
  }, [user]);

  const handleChange = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  const handleSave = async () => {
    await patchMe({
      avatar_url: avatarUrl,
      username: form.username,
      birth_date: form.birth_date,
      platform: form.platform,
      notifications: form.notifications,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    const { file_url } = await uploadAvatar({ file });
    setAvatarUrl(file_url);
    setUploadingAvatar(false);
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-lg mx-auto px-4 py-8">
        {/* Back */}
        <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Torna alla chat
        </Link>

        {/* Avatar */}
        <div className="flex flex-col items-center mb-8">
          <div className="relative">
            <div className="w-20 h-20 rounded-full overflow-hidden bg-primary/20 border-2 border-primary/30 flex items-center justify-center">
              {avatarUrl ? (
                <img src={avatarUrl} alt="avatar" className="w-full h-full object-cover" />
              ) : (
                <span className="text-3xl">{form.full_name?.[0] || "?"}</span>
              )}
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAvatar}
              className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-primary flex items-center justify-center shadow-lg hover:bg-primary/90 transition-colors"
            >
              {uploadingAvatar ? (
                <div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              ) : (
                <Camera className="w-3.5 h-3.5 text-white" />
              )}
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
          </div>
          <p className="text-xs text-muted-foreground mt-2">Clicca sulla fotocamera per cambiare avatar</p>
        </div>

        <h1 className="text-xl font-bold text-foreground mb-1">Impostazioni account</h1>
        <p className="text-sm text-muted-foreground mb-6">Gestisci le informazioni del tuo profilo</p>

        <div className="space-y-4">

          {/* Dati personali */}
          <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
            <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
              <User className="w-4 h-4 text-muted-foreground" /> Dati personali
            </h2>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Nome completo</label>
              <input
                value={form.full_name}
                disabled
                className="w-full bg-muted text-muted-foreground text-sm px-3 py-2 rounded-lg border border-border cursor-not-allowed opacity-60"
              />
              <p className="text-[10px] text-muted-foreground/50">Il nome non può essere modificato</p>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Nome utente</label>
              <input
                value={form.username}
                onChange={(e) => handleChange("username", e.target.value)}
                placeholder="es. platinatore99"
                className="w-full bg-background text-foreground text-sm px-3 py-2 rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Data di nascita</label>
              <input
                type="date"
                value={form.birth_date}
                onChange={(e) => handleChange("birth_date", e.target.value)}
                className="w-full bg-background text-foreground text-sm px-3 py-2 rounded-lg border border-border focus:border-primary focus:outline-none transition-colors"
              />
            </div>
          </div>

          {/* Email */}
          <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
            <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Mail className="w-4 h-4 text-muted-foreground" /> Email
            </h2>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Indirizzo email</label>
              <input
                value={form.email}
                disabled
                className="w-full bg-muted text-muted-foreground text-sm px-3 py-2 rounded-lg border border-border cursor-not-allowed opacity-60"
              />
              <p className="text-[10px] text-muted-foreground/50">L'email non può essere modificata</p>
            </div>
          </div>

          {/* Password */}
          <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
            <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Lock className="w-4 h-4 text-muted-foreground" /> Password
            </h2>
            <p className="text-xs text-muted-foreground">Per cambiare la password, usa il link di reset inviato via email.</p>
            <button
              onClick={() => navigateToLogin(window.location.href)}
              className="text-xs text-primary hover:underline"
            >
              Richiedi reset password →
            </button>
          </div>

          {/* Piattaforma */}
          <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
            <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Gamepad2 className="w-4 h-4 text-muted-foreground" /> Piattaforma preferita
            </h2>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((p) => (
                <button
                  key={p}
                  onClick={() => handleChange("platform", p)}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${
                    form.platform === p
                      ? "bg-primary/20 border-primary/60 text-primary font-semibold"
                      : "bg-muted border-border text-muted-foreground hover:text-foreground hover:border-primary/30"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Notifiche */}
          <div className="bg-card border border-border rounded-2xl p-5">
            <h2 className="text-sm font-bold text-foreground flex items-center gap-2 mb-4">
              <Bell className="w-4 h-4 text-muted-foreground" /> Notifiche
            </h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-foreground">Notifiche email</p>
                <p className="text-xs text-muted-foreground">Ricevi aggiornamenti e novità via email</p>
              </div>
              <Switch
                checked={form.notifications}
                onCheckedChange={(v) => handleChange("notifications", v)}
              />
            </div>
          </div>

          {/* Save */}
          <Button
            onClick={handleSave}
            className="w-full gap-2"
          >
            <Save className="w-4 h-4" />
            {saved ? "Salvato ✓" : "Salva modifiche"}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}