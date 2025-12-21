/**
 * HDFilmCehennemi Stremio Addon - Custom Error Classes
 * 
 * Provides structured error types for better error handling and user feedback.
 */

/**
 * Base error class for HDFilmCehennemi addon
 */
class HDFCError extends Error {
    /**
     * @param {string} message - Error message
     * @param {string} code - Error code for programmatic handling
     * @param {Object} [details] - Additional error details
     */
    constructor(message, code, details = null) {
        super(message);
        this.name = 'HDFCError';
        this.code = code;
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }

    /**
     * Get user-friendly error message
     * @returns {string} User-friendly message
     */
    getUserMessage() {
        return 'Bir hata oluştu. Lütfen daha sonra tekrar deneyin.';
    }
}

/**
 * Content not found on HDFilmCehennemi
 */
class ContentNotFoundError extends HDFCError {
    /**
     * @param {string} query - Search query or title that wasn't found
     * @param {Object} [details] - Additional details about the search
     */
    constructor(query, details = null) {
        super(`İçerik bulunamadı: ${query}`, 'CONTENT_NOT_FOUND', details);
        this.name = 'ContentNotFoundError';
        this.query = query;
    }

    getUserMessage() {
        return `"${this.query}" HDFilmCehennemi'de bulunamadı.`;
    }
}

/**
 * Failed to scrape/extract video data
 */
class ScrapingError extends HDFCError {
    /**
     * @param {string} message - Error description
     * @param {string} url - URL that failed to scrape
     * @param {Object} [details] - Additional details
     */
    constructor(message, url, details = null) {
        super(message, 'SCRAPING_FAILED', { url, ...details });
        this.name = 'ScrapingError';
        this.url = url;
    }

    getUserMessage() {
        return 'Video bilgileri alınamadı. Kaynak geçici olarak kullanılamıyor olabilir.';
    }
}

/**
 * Network/HTTP request failure
 */
class NetworkError extends HDFCError {
    /**
     * @param {string} message - Error description
     * @param {string} url - URL that failed
     * @param {number} [statusCode] - HTTP status code if available
     * @param {Object} [details] - Additional details
     */
    constructor(message, url, statusCode = null, details = null) {
        super(message, 'NETWORK_ERROR', { url, statusCode, ...details });
        this.name = 'NetworkError';
        this.url = url;
        this.statusCode = statusCode;
    }

    getUserMessage() {
        if (this.statusCode === 404) {
            return 'İçerik mevcut değil veya kaldırılmış.';
        }
        if (this.statusCode === 429) {
            return 'Çok fazla istek gönderildi. Lütfen biraz bekleyin.';
        }
        if (this.statusCode >= 500) {
            return 'HDFilmCehennemi sunucusu geçici olarak kullanılamıyor.';
        }
        return 'Bağlantı hatası. Lütfen internet bağlantınızı kontrol edin.';
    }
}

/**
 * Timeout error for requests
 */
class TimeoutError extends NetworkError {
    /**
     * @param {string} url - URL that timed out
     * @param {number} timeout - Timeout duration in ms
     */
    constructor(url, timeout) {
        super(`İstek zaman aşımına uğradı (${timeout}ms)`, url, null, { timeout });
        this.name = 'TimeoutError';
        this.code = 'TIMEOUT';
        this.timeout = timeout;
    }

    getUserMessage() {
        return 'İstek zaman aşımına uğradı. Lütfen tekrar deneyin.';
    }
}

/**
 * Invalid input parameters
 */
class ValidationError extends HDFCError {
    /**
     * @param {string} message - Validation error description
     * @param {string} field - Field that failed validation
     * @param {*} value - The invalid value
     */
    constructor(message, field, value) {
        super(message, 'VALIDATION_ERROR', { field, value });
        this.name = 'ValidationError';
        this.field = field;
        this.value = value;
    }

    getUserMessage() {
        return `Geçersiz parametre: ${this.field}`;
    }
}

/**
 * Rate limiting error
 */
class RateLimitError extends HDFCError {
    /**
     * @param {string} message - Rate limit description
     */
    constructor(message = 'Çok fazla eşzamanlı istek') {
        super(message, 'RATE_LIMIT');
        this.name = 'RateLimitError';
    }

    getUserMessage() {
        return 'Sunucu meşgul. Lütfen biraz bekleyin.';
    }
}

module.exports = {
    ContentNotFoundError,
    ScrapingError,
    NetworkError,
    TimeoutError,
    ValidationError
};
