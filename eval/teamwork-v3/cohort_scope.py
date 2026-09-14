"""Explicit user-requested exclusion; never silently drop a competitor."""
ALL_ARMS = ('ledger', 'graphify', 'gbrain', 'supermemory')

def expected_arms(config):
    scope = config.get('cohort_scope')
    if scope is None:
        return ALL_ARMS
    if not isinstance(scope, dict) or scope.get('included_arms') != list(ALL_ARMS[:3]) or scope.get('excluded_arms') != ['supermemory'] or not isinstance(scope.get('authorization'), str) or not scope['authorization'].strip():
        raise ValueError('explicit authorized three-product scope required')
    return ALL_ARMS[:3]
