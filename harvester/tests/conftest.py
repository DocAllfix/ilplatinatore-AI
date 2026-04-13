import os

# Imposta DATABASE_URL prima che qualsiasi modulo tenti di istanziare Settings().
# settings = Settings() è a livello modulo: senza questa riga ogni import di
# src.config.settings nei test fallirebbe con ValidationError "Field required".
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test_db")
