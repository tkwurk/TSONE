/**
 * RBAC helpers (Snowbee B1/B2).
 */

function parseCsvList_(value) {
  if (!value) return [];
  return value.toString().split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

function uniqueList_(arr) {
  var seen = {};
  var out = [];
  (arr || []).forEach(function(item) {
    if (item && !seen[item]) {
      seen[item] = true;
      out.push(item);
    }
  });
  return out;
}

function normalizeAllowedTabsForRole_(allowedTabs, role) {
  var roleKey = normalizeRole_(role);
  if (roleKey === 'admin') {
    return ['*'];
  }
  var list = Array.isArray(allowedTabs) ? allowedTabs.slice() : parseCsvList_(allowedTabs);
  if (list.indexOf('*') >= 0 || list.indexOf('admin') >= 0) {
    return ['*'];
  }
  if (!list.length && roleKey) {
    return resolveEffectiveTabs({ role: roleKey });
  }
  return list;
}

/**
 * @param {{role?:string,extra_tabs?:string,denied_tabs?:string,allowedTabs?:string}} person
 * @returns {string[]}
 */
function resolveEffectiveTabs(person) {
  if (!person) return getRoleTabsFromSheet_('cashier');

  if (person.allowedTabs && typeof person.allowedTabs === 'string' && !person.role) {
    return normalizeAllowedTabsForRole_(parseCsvList_(person.allowedTabs), inferRoleFromAllowedTabs_(person.allowedTabs));
  }

  var role = normalizeRole_(person.role);
  var base = getRoleTabsFromSheet_(role);
  if (base.indexOf('*') >= 0) {
    var deniedOnly = parseCsvList_(person.denied_tabs);
    if (deniedOnly.length === 0) {
      return ['*'];
    }
    base = getAllTabIds_();
  }

  var extra = parseCsvList_(person.extra_tabs);
  var denied = parseCsvList_(person.denied_tabs);
  var merged = base.concat(extra).filter(function(tab) {
    return denied.indexOf(tab) === -1;
  });
  return normalizeAllowedTabsForRole_(uniqueList_(merged), role);
}

function resolveEffectiveTabsFromSession(session) {
  if (!session) return [];
  if (session.allowedTabs && Array.isArray(session.allowedTabs)) {
    return session.allowedTabs;
  }
  return resolveEffectiveTabs({
    role: session.role,
    extra_tabs: session.extra_tabs,
    denied_tabs: session.denied_tabs,
    allowedTabs: session.allowedTabsLegacy
  });
}

function requireAuth_(params) {
  var ctx = (params && params._authContext) || params || {};
  var deviceId = ctx.deviceId;
  var username = ctx.username;
  if (!deviceId || !username) {
    throw new Error('Authentication required');
  }
  var session = getUserSessionEnhanced(deviceId, username);
  if (!session || !session.username || session.username !== username) {
    throw new Error('Invalid or expired session');
  }
  if (session.active === false || session.active === 'N') {
    throw new Error('Account is inactive');
  }
  // Role/tabs/outlet are refreshed from People inside getUserSessionEnhanced at most
  // every SESSION_PEOPLE_REFRESH_MS (login.js). Re-reading the whole People sheet
  // here on every request made each submission slower for no extra safety.
  if (!session.outlet && typeof resolveUserOutlet_ === 'function') {
    session.outlet = resolveUserOutlet_(username, session.outlet);
  }
  return session;
}

function requirePermission_(params, permission) {
  var session = requireAuth_(params);
  var tabs = resolveEffectiveTabsFromSession(session);
  if (tabs.indexOf('*') >= 0 || tabs.indexOf(permission) >= 0) {
    return session;
  }
  throw new Error('Permission denied: ' + permission);
}

function requireAdmin_(params) {
  return requirePermission_(params, 'adminOrders');
}

function filterRowsByOutlet_(rows, outletIdx, userOutlet) {
  if (!userOutlet || outletIdx === -1) return rows;
  return rows.filter(function(row) {
    return !row[outletIdx] || row[outletIdx] === userOutlet;
  });
}

function authContextFromParams_(params) {
  return (params && params._authContext) ? params._authContext : null;
}
