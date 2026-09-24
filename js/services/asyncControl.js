// A timeout ends the caller's wait, not an already submitted server write.
// Retry writes only with a stable ID and an atomic existence check.
export function withDeadline(operation, milliseconds = 30000, code = 'deadline-exceeded') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error('El servidor no confirmó la operación a tiempo.');
            error.code = code;
            reject(error);
        }, milliseconds);
    });
    return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

export async function runLimited(items, worker, { concurrency = 4, stopOnError = true, onProgress = () => {} } = {}) {
    let cursor = 0;
    let stopped = false;
    const results = new Array(items.length);
    async function consume() {
        while (!stopped && cursor < items.length) {
            const index = cursor++;
            try {
                results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
                // Bug 8: solo detener si stopOnError está habilitado.
                // En doImport se pasa stopOnError:false para que un timeout parcial
                // de Firestore no cancele el guardado de las demás transacciones.
                if (stopOnError) stopped = true;
            }
            onProgress(results[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, consume));
    return results;
}
