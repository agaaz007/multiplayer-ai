"""Explicit cohort declarations; never silently drop or add an arm.

Decision 7A (2026-09-13 review) adds two baseline control arms alongside the four
memory products: `control-git` (teammates share work only through a bare Git
remote) and `handoff-note` (teammates share work only through HANDOFF.md notes).
The default scope stays the four-product cohort; every other cohort must be
declared with a written authorization. Declared scopes are closed-form so a
missing lane can never be inferred as an exclusion.
"""
PRODUCT_ARMS = ('ledger', 'graphify', 'gbrain', 'supermemory')
CONTROL_ARMS = ('control-git', 'handoff-note')
ALL_ARMS = PRODUCT_ARMS + CONTROL_ARMS
# Arms with no MCP memory servers, no hooks and no paid provider path. The stage
# driver, transport and lifecycle treat them alike; `fresh-agent` is the legacy v2 name.
BASELINE_CONTROLS = ('fresh-agent',) + CONTROL_ARMS

SCOPES = {
    'three-product': (list(PRODUCT_ARMS[:3]), ['supermemory']),
    'products': (list(PRODUCT_ARMS), list(CONTROL_ARMS)),
    'controls': (list(CONTROL_ARMS), list(PRODUCT_ARMS)),
    'six-arm': (list(ALL_ARMS), []),
    # The bake-off the user asked for on 2026-09-15: Ledger against "just commit" and
    # "just write a note", runnable without OpenAI/Supermemory provider routes.
    'ledger-vs-controls': (['ledger'] + list(CONTROL_ARMS), [a for a in PRODUCT_ARMS if a != 'ledger']),
}
LABELS = {3: 'three-product', 4: 'four-product', 2: 'two-control', 6: 'six-arm'}


def batch_scope(name, authorization):
    """Declare a cohort batch (`products`, `controls`, `six-arm`, `three-product`)."""
    if name not in SCOPES:
        raise ValueError('unknown cohort batch: ' + str(name))
    if not isinstance(authorization, str) or not authorization.strip():
        raise ValueError('cohort batch requires a written authorization')
    included, excluded = SCOPES[name]
    return {'included_arms': list(included), 'excluded_arms': list(excluded), 'authorization': authorization, 'batch': name}


def expected_arms(config):
    scope = config.get('cohort_scope')
    if scope is None:
        return PRODUCT_ARMS
    if isinstance(scope, dict) and isinstance(scope.get('authorization'), str) and scope['authorization'].strip():
        for included, excluded in SCOPES.values():
            if scope.get('included_arms') == included and scope.get('excluded_arms') == excluded:
                return tuple(included)
    raise ValueError('explicit authorized three-product, products, controls or six-arm scope required')


def cohort_label(arms):
    for name, (included, _excluded) in SCOPES.items():
        if list(arms) == included:
            return name if name != 'products' else 'four-product'
    return LABELS.get(len(arms), str(len(arms)) + '-arm')


def is_control(arm):
    return arm in BASELINE_CONTROLS
