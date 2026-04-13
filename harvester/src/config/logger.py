import logging

import structlog

from src.config.settings import settings


def setup_logging() -> None:
    """Configura structlog: JSON in prod, console colorata in dev (DEBUG)."""
    log_level = getattr(logging, settings.log_level.upper(), logging.INFO)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            (
                structlog.dev.ConsoleRenderer()
                if log_level == logging.DEBUG
                else structlog.processors.JSONRenderer()
            ),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
    )


def get_logger(name: str) -> structlog.BoundLogger:
    """Restituisce un logger con il campo 'logger' già bindato al nome del modulo."""
    return structlog.get_logger().bind(logger=name)


# Configura al momento dell'import.
# Chiunque faccia `from src.config.logger import get_logger`
# ottiene un logger già configurato senza dover chiamare setup_logging().
setup_logging()
