(() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const token = fragment.get("pair");
    window.orielPairing = {
        token: /^[0-9a-f]{64}$/.test(token ?? "") ? token : null,
        invalid: fragment.has("pair") && !/^[0-9a-f]{64}$/.test(token ?? ""),
    };
    window.orielConnection = {
        returned: ["github", "linear"].includes(fragment.get("connected")) ? fragment.get("connected") : null,
        failed: fragment.has("connection-error"),
    };
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
})();
