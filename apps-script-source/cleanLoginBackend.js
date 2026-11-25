/**
 * ✅ CLEAN LOGIN BACKEND - Google Apps Script
 * Simple authentication functions to replace the complex login system
 */

/**
 * Clear only this login attempt's session keys — not all devices for the user.
 * clearAllUserSessions during login caused race conditions when switching users quickly.
 */
function clearStaleSessionsForLogin_(formUsername, canonicalUsername, deviceId, resolvedDeviceId) {
  try {
    if (resolvedDeviceId && canonicalUsername) {
      clearUserSession(resolvedDeviceId, canonicalUsername);
    }
    if (deviceId && deviceId !== resolvedDeviceId) {
      clearUserSession(deviceId, canonicalUsername);
      if (formUsername && formUsername !== canonicalUsername) {
        clearUserSession(deviceId, formUsername);
      }
    }
  } catch (e) {
    Logger.log('clearStaleSessionsForLogin_ warning: ' + e.toString());
  }
}

/**
 * Enhanced login function that works with the clean frontend
 * Combines validation, session cleanup, and creation in one call
 */
function authenticateUserClean(username, password, deviceId) {
  try {
    Logger.log("Clean authentication started for: " + username);
    
    // Step 1: Validate credentials
    const validation = validateLoginWithAllowedTabs(username, password);
    if (!validation.success) {
      return { 
        success: false, 
        message: "Invalid credentials" 
      };
    }

    var resolvedOutlet = typeof resolveUserOutlet_ === 'function'
      ? resolveUserOutlet_(validation.username, validation.outlet)
      : (validation.outlet || '');
    if (!resolvedOutlet) {
      return {
        success: false,
        message: "No outlet assigned to this account. Ask admin to set outlet on the People sheet."
      };
    }
    validation.outlet = resolvedOutlet;

    var canonicalUsername = validation.username;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      return { success: false, message: 'Login in progress — please wait a moment and try again' };
    }

    try {
    var resolvedDeviceId = typeof ensureDeviceIdForUser_ === 'function'
      ? ensureDeviceIdForUser_(deviceId, canonicalUsername)
      : deviceId;

    clearStaleSessionsForLogin_(username, canonicalUsername, deviceId, resolvedDeviceId);
    
    // Create new session under canonical username (People person_id)
    const loginResult = login(
      canonicalUsername,
      validation.outlet,
      normalizeAllowedTabsForRole_(validation.allowedTabs, validation.role),
      resolvedDeviceId,
      validation.role
    );
    
    if (loginResult) {
      // (No more active_session_<username> record: only the unused resume path read it.)
      var verified = getUserSessionEnhanced(resolvedDeviceId, canonicalUsername);
      if (!verified) {
        Logger.log("CRITICAL: Session not readable after login for " + canonicalUsername);
        return {
          success: false,
          message: "Session could not be established. Please try again."
        };
      }
      
      Logger.log("Clean authentication successful for: " + canonicalUsername);
      return {
        success: true,
        username: canonicalUsername,
        outlet: validation.outlet,
        allowedTabs: normalizeAllowedTabsForRole_(validation.allowedTabs, validation.role),
        role: validation.role || 'cashier',
        deviceId: resolvedDeviceId,
        message: "Login successful"
      };
    } else {
      return { 
        success: false, 
        message: "Failed to create session" 
      };
    }
    } finally {
      lock.releaseLock();
      // Housekeeping outside the lock: at most hourly, a bounded number of deletions.
      try { purgeStaleSessionProperties_({ max: 50 }); } catch (e) { Logger.log('session purge warning: ' + e); }
    }
    
  } catch (error) {
    Logger.log("Clean authentication error: " + error.toString());
    return { 
      success: false, 
      message: "Authentication failed: " + error.message 
    };
  }
}

/**
 * Simple session validation
 */
function validateUserSession(deviceId, username) {
  try {
    const session = getUserSessionEnhanced(deviceId, username);
    
    if (session && session.username === username) {
      syncActiveSessionOutlet_(username, session);
      return {
        valid: true,
        username: session.username,
        outlet: session.outlet,
        allowedTabs: session.allowedTabs || [],
        role: session.role || 'cashier'
      };
    } else {
      return { valid: false, reason: "No valid session found" };
    }
    
  } catch (error) {
    Logger.log("Session validation error: " + error.toString());
    return { valid: false, reason: "Validation failed" };
  }
}

function syncActiveSessionOutlet_(username, session) {
  if (!username || !session) return;
  try {
    var scriptProps = PropertiesService.getScriptProperties();
    var activeKey = 'active_session_' + username;
    var activeJson = scriptProps.getProperty(activeKey);
    if (!activeJson) return;
    var active = JSON.parse(activeJson);
    if (!active.active) return;
    active.outlet = session.outlet;
    active.role = session.role || active.role || 'cashier';
    active.allowedTabs = session.allowedTabs || active.allowedTabs || [];
    scriptProps.setProperty(activeKey, JSON.stringify(active));
  } catch (e) {
    Logger.log('syncActiveSessionOutlet_ warning: ' + e.toString());
  }
}

/**
 * Session validation alias for SecurityWrapper.refreshSession().
 * Canonical session keys: session_{username}_{deviceId}, active_session_{username}
 */
function validateSessionWithUserData(deviceId, username) {
  return validateUserSession(deviceId, username);
}

/**
 * End one browser session when switching users on a shared device.
 * Does not log the user out of other devices.
 */
function endBrowserSessionForUser(deviceId, username) {
  try {
    if (username) {
      try {
        PropertiesService.getScriptProperties().deleteProperty('active_session_' + username);
      } catch (e) {
        Logger.log('endBrowserSessionForUser active_session warning: ' + e.toString());
      }
    }
    if (deviceId && username) {
      return clearUserSession(deviceId, username);
    }
    return { success: false, reason: 'deviceId and username required' };
  } catch (error) {
    Logger.log('endBrowserSessionForUser error: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Clean logout that clears user sessions
 * Only called on EXPLICIT logout (not page refresh)
 */
function logoutUser(deviceId, username) {
  try {
    // Clear the active session reference so refresh won't resume
    if (username) {
      try {
        PropertiesService.getScriptProperties().deleteProperty('active_session_' + username);
        Logger.log("Active session cleared for: " + username);
      } catch (e) {
        Logger.log("Warning: Could not clear active session: " + e.toString());
      }
    }

    // Prefer targeted clear when we know both device + user (shared terminal switch)
    if (deviceId && username) {
      var targeted = clearUserSession(deviceId, username);
      Logger.log("Clean logout (this device) completed: " + JSON.stringify(targeted));
      return targeted;
    }
    
    const result = logout(deviceId);
    Logger.log("Clean logout completed: " + JSON.stringify(result));
    return result;
  } catch (error) {
    Logger.log("Logout error: " + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Resume session after page refresh
 * Called with username from client cookie/sessionStorage
 * Returns the active session if it exists (not explicitly logged out)
 */
function resumeSessionByUsername(username) {
  try {
    if (!username) {
      return { valid: false, reason: "No username provided" };
    }
    
    var scriptProps = PropertiesService.getScriptProperties();
    var activeJson = scriptProps.getProperty('active_session_' + username);
    
    if (!activeJson) {
      Logger.log("No active session found for: " + username);
      return { valid: false, reason: "No active session" };
    }
    
    var activeSession = JSON.parse(activeJson);
    
    if (!activeSession.active) {
      Logger.log("Session marked inactive for: " + username);
      return { valid: false, reason: "Session inactive" };
    }
    
    // Check session age (24 hours max)
    var now = new Date().getTime();
    var sessionAge = now - activeSession.loginTime;
    var maxAge = 24 * 60 * 60 * 1000;
    
    if (sessionAge > maxAge) {
      Logger.log("Active session expired for: " + username);
      scriptProps.deleteProperty('active_session_' + username);
      return { valid: false, reason: "Session expired" };
    }
    
    // Validate the actual session still exists in ScriptProperties
    var session = getUserSessionEnhanced(activeSession.deviceId, username);
    if (!session || session.username !== username) {
      Logger.log("Underlying session missing for: " + username);
      scriptProps.deleteProperty('active_session_' + username);
      return { valid: false, reason: "Session data missing" };
    }

    session = refreshSessionAuthFromPeople_(username, session) || session;
    syncActiveSessionOutlet_(username, session);
    var allowedTabs = session.allowedTabs || activeSession.allowedTabs || [];
    var role = session.role || activeSession.role || 'cashier';
    
    Logger.log("Session resumed successfully for: " + username + " with deviceId: " + activeSession.deviceId);
    return {
      valid: true,
      username: session.username,
      outlet: session.outlet,
      allowedTabs: allowedTabs,
      role: role,
      deviceId: activeSession.deviceId
    };
    
  } catch (error) {
    Logger.log("resumeSessionByUsername error: " + error.toString());
    return { valid: false, reason: "Resume failed" };
  }
}
