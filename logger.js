/**
 * HDFilmCehennemi Stremio Addon - Logger Module
 * 
 * Centralized logging utility with configurable log levels.
 * Set LOG_LEVEL environment variable to: debug, info, warn, error
 */

const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

// ANSI color codes for terminal output
const COLORS = {
    reset: '\x1b[0m',
    debug: '\x1b[36m',  // Cyan
    info: '\x1b[32m',   // Green
    warn: '\x1b[33m',   // Yellow
    error: '\x1b[31m',  // Red
    dim: '\x1b[2m',     // Dim
    bold: '\x1b[1m'     // Bold
};

/**
 * Get the configured log level from environment
 * @returns {number} Log level threshold
 */
function getLogLevel() {
    const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
    return LOG_LEVELS[level] ?? LOG_LEVELS.info;
}

/**
 * Format timestamp for log messages
 * @returns {string} Formatted timestamp [HH:MM:SS]
 */
function getTimestamp() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

/**
 * Format and output a log message
 * @param {'debug'|'info'|'warn'|'error'} level - Log level
 * @param {string} context - Module/function context
 * @param {string} message - Log message
 * @param {Object} [data] - Optional data to include
 */
function log(level, context, message, data = null) {
    const currentLevel = getLogLevel();
    const messageLevel = LOG_LEVELS[level];

    if (messageLevel < currentLevel) return;

    const timestamp = getTimestamp();
    const color = COLORS[level];
    const levelTag = level.toUpperCase().padEnd(5);

    let output = `${COLORS.dim}[${timestamp}]${COLORS.reset} ${color}${COLORS.bold}${levelTag}${COLORS.reset} ${COLORS.dim}[${context}]${COLORS.reset} ${message}`;

    if (level === 'error') {
        console.error(output);
        if (data) console.error(data);
    } else if (level === 'warn') {
        console.warn(output);
        if (data) console.warn(data);
    } else {
        console.log(output);
        if (data) console.log(data);
    }
}

/**
 * Create a logger instance with a specific context
 * @param {string} context - Module/function name for log prefix
 * @returns {Object} Logger instance with debug, info, warn, error methods
 */
function createLogger(context) {
    return {
        /**
         * Log debug message (only shown when LOG_LEVEL=debug)
         * @param {string} message - Log message
         * @param {Object} [data] - Optional data
         */
        debug: (message, data) => log('debug', context, message, data),

        /**
         * Log info message
         * @param {string} message - Log message
         * @param {Object} [data] - Optional data
         */
        info: (message, data) => log('info', context, message, data),

        /**
         * Log warning message
         * @param {string} message - Log message
         * @param {Object} [data] - Optional data
         */
        warn: (message, data) => log('warn', context, message, data),

        /**
         * Log error message
         * @param {string} message - Log message
         * @param {Object} [data] - Optional data
         */
        error: (message, data) => log('error', context, message, data)
    };
}

module.exports = { createLogger, LOG_LEVELS };
