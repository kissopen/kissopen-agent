/** NetUserAdd limits local account names to 20 characters. Validate before compiling. */
export function assertWindowsSandboxAccounts(source) {
    const accounts = [
        ...source.matchAll(
            /^\+?pub const (OFFLINE_USERNAME|ONLINE_USERNAME): &str = "([^"]+)";/gmu,
        ),
    ];
    if (accounts.length !== 2 || new Set(accounts.map((match) => match[1])).size !== 2)
        throw new Error("Sandbox source must declare both Windows account names.");
    for (const [, constant, name] of accounts) {
        if (name.length < 1 || name.length > 20)
            throw new Error(
                `${constant} '${name}' exceeds the Windows local account limit of 20 characters.`,
            );
    }
    if (accounts[0][2].toLowerCase() === accounts[1][2].toLowerCase())
        throw new Error("Offline and online sandbox accounts must be distinct.");
}
