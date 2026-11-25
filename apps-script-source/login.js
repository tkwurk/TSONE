// Canonical authentication (Project Snowbee A1)
// Session keys: session_{username}_{deviceId}, active_session_{username}
// Entry API: cleanLoginBackend.js (authenticateUserClean, validateUserSession, logoutUser, resumeSessionByUsername)

function validateLoginWithAllowedTabs(username, code) {
  if (typeof validateLoginPersonOrUser_ === 'function') {
    return validateLoginPersonOrUser_(username, code);
  }
  return { success: false, message: 'People auth not available' };
}

/**
 * Device ID used in session keys: <device base>_user_<username>.
 * Deterministic: the same physical device + user always maps to the same ID,
 * so logging in again (e.g. users taking turns on a shared till) overwrites
 * one session instead of creating a new Script Property each time.
 * The base is whatever the client sent, minus any previous user suffix.
 */
function ensureDeviceIdForUser_(deviceId, canonicalUsername) {
  var suffix = '_user_' + String(canonicalUsername || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  var base = String(deviceId || '').replace(/_user_[a-z0-9]*$/, '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(base)) {
    base = 'device_' + new Date().getTime() + '_session_' + Math.floor(Math.random() * 1e15).toString(36);
  }
  return base + suffix;
}

function login(username, outlet, allowedTabs, deviceId, role) {
  if (!deviceId) {
    throw new Error('Device ID is required for login');
  }
  
  const sessionData = {
    username: username,
    deviceId: deviceId,
    outlet: outlet,
    allowedTabs: allowedTabs,
    role: role || 'cashier',
    loginTime: new Date().getTime(),
    lastActivity: new Date().getTime()
  };
  
  // Use PropertiesService.getScriptProperties() to store device-specific sessions
  // Include username in session key to prevent outlet data mixing between users
  const scriptProps = PropertiesService.getScriptProperties();
  const sessionKey = 'session_' + username + '_' + deviceId;
  scriptProps.setProperty(sessionKey, JSON.stringify(sessionData));
  // (No more user_devices_<username> list: nothing reads it and it only grew.)

  Logger.log("Login successful - Username: " + username + ", Outlet: " + outlet + ", DeviceId: " + deviceId);
  
  return true;
}

function clearUserSession(deviceId, username) {
  if (!deviceId) {
    Logger.log("clearUserSession: No deviceId provided");
    return { success: false, error: "No deviceId provided" };
  }
  
  // Get the session to find the username before clearing (if not provided)
  let session = null;
  let actualUsername = username;
  
  if (!actualUsername) {
    // Try to get session with enhanced method first
    session = getUserSessionEnhanced(deviceId);
    actualUsername = session ? session.username : null;
  }
  
  Logger.log("clearUserSession: Clearing session for deviceId: " + deviceId + (actualUsername ? " (user: " + actualUsername + ")" : ""));
  
  const scriptProps = PropertiesService.getScriptProperties();
  
  // Try to clear both old and new format session keys
  const sessionKeys = [];
  if (actualUsername) {
    sessionKeys.push('session_' + actualUsername + '_' + deviceId); // New format
  }
  
  let clearedCount = 0;
  if (sessionKeys.length > 0) {
    try {
      // Check if session exists before deletion
      const existingSession = scriptProps.getProperty(sessionKeys[0]);
      if (existingSession) {
        scriptProps.deleteProperty(sessionKeys[0]);
        clearedCount++;
        Logger.log("clearUserSession: Successfully deleted session property: " + sessionKeys[0]);
      } else {
        Logger.log("clearUserSession: Session property did not exist: " + sessionKeys[0]);
      }
      
      // Verify deletion
      const verifySession = scriptProps.getProperty(sessionKeys[0]);
      if (verifySession) {
        Logger.log("WARNING: Session still exists after deletion attempt: " + sessionKeys[0]);
        return { success: false, error: "Failed to delete session property: " + sessionKeys[0] };
      }
      
    } catch (error) {
      Logger.log("clearUserSession: Error deleting session property " + sessionKeys[0] + ": " + error.toString());
    }
  }
  
  Logger.log("clearUserSession: Session cleared successfully for deviceId: " + deviceId + " (cleared " + clearedCount + " session keys)");
  return { success: clearedCount > 0, username: actualUsername, deviceId: deviceId, clearedCount: clearedCount };
}

// Clean up expired sessions (can be called periodically)
var SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // same limit getUserSessionEnhanced enforces
var SESSION_PURGE_EVERY_S = 60 * 60;           // automatic purge at most hourly

/**
 * Removes Script Properties that only old login code created:
 *  - session_*        expired (idle > 24 h, already rejected on use) or unreadable
 *  - user_devices_*   per-user device lists (no longer written or read)
 *  - active_session_* per-user "resume" records (no longer written; app never resumes)
 * Everything else (SPREADSHEET_ID, schedules, keys, …) is never touched.
 * @param {{ max?: number, force?: boolean }} options  max deletions this run;
 *   without force, runs at most once per SESSION_PURGE_EVERY_S.
 * @return {{ checked: number, deleted: Object, remaining: number, skipped?: string }}
 */
function purgeStaleSessionProperties_(options) {
  options = options || {};
  var result = { checked: 0, deleted: { expiredSessions: 0, deviceLists: 0, activeSessions: 0 }, remaining: 0 };
  var cache = CacheService.getScriptCache();
  if (!options.force) {
    if (cache.get('session_purge_ran')) { result.skipped = 'ran recently'; return result; }
    cache.put('session_purge_ran', '1', SESSION_PURGE_EVERY_S);
  }
  var max = options.max || Infinity;
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var now = Date.now();
  var deletedTotal = 0;
  Object.keys(all).forEach(function (key) {
    var kind = null;
    if (key.indexOf('user_devices_') === 0) kind = 'deviceLists';
    else if (key.indexOf('active_session_') === 0) kind = 'activeSessions';
    else if (key.indexOf('session_') === 0) {
      result.checked++;
      try {
        var s = JSON.parse(all[key]);
        if (!(now - Number(s.lastActivity) <= SESSION_MAX_AGE_MS)) kind = 'expiredSessions';
      } catch (e) {
        kind = 'expiredSessions';
      }
    }
    if (!kind) return;
    if (deletedTotal >= max) { result.remaining++; return; }
    props.deleteProperty(key);
    result.deleted[kind]++;
    deletedTotal++;
  });
  return result;
}

/**
 * Run from the Apps Script editor (Run ▸ cleanUpSessionProperties) to clear the
 * backlog at once. Safe: signed-in users keep their sessions (see purge rules).
 */
function cleanUpSessionProperties() {
  var before = Object.keys(PropertiesService.getScriptProperties().getProperties()).length;
  var result = purgeStaleSessionProperties_({ force: true });
  var after = Object.keys(PropertiesService.getScriptProperties().getProperties()).length;
  result.before = before;
  result.after = after;
  Logger.log('cleanUpSessionProperties: ' + JSON.stringify(result));
  return result;
}

// Debug function to check session state
function debugSessionState(deviceId, username) {
  const session = getUserSessionEnhanced(deviceId, username);
  Logger.log("Debug Session State:");
  Logger.log("Session object: " + JSON.stringify(session));
  
  if (!session) {
    Logger.log("Session is null or undefined");
    return { status: 'no_session', message: 'No session found' };
  }
  
  if (!session.username) {
    Logger.log("Session exists but username is missing: " + JSON.stringify(session));
    return { status: 'missing_username', session: session };
  }
  
  if (!session.outlet) {
    Logger.log("Session exists but outlet is missing: " + JSON.stringify(session));
    return { status: 'missing_outlet', session: session };
  }
  
  Logger.log("Session appears valid: " + JSON.stringify(session));
  return { status: 'valid', session: session };
}

// Test function to verify session data is saved correctly
function testSessionSaving() {
  Logger.log("=== Testing Session Saving ===");
  
  // Test login
  const testDeviceId = "test_device_123";
  const testUsername = "testuser";
  const testOutlet = "TestOutlet";
  const testTabs = ["orders", "deposits"];
  
  try {
    login(testUsername, testOutlet, testTabs, testDeviceId);
    Logger.log("Login completed");
    
    // Test session retrieval
    const session1 = getUserSessionEnhanced(testDeviceId);
    Logger.log("Device-based session: " + JSON.stringify(session1));
    
    const debugResult = debugSessionState(testDeviceId);
    Logger.log("Debug result: " + JSON.stringify(debugResult));
    
    // Cleanup
    clearUserSession(testDeviceId);
    Logger.log("Test completed");
    
    return {
      deviceSession: session1,
      debugResult: debugResult
    };
    
  } catch (error) {
    Logger.log("Test failed: " + error.toString());
    return { error: error.toString() };
  }
}

// Simple function to test if session data is available for debugging
function getCurrentSessionInfo(deviceId, username) {
  const session = getUserSessionEnhanced(deviceId, username) || {};
  
  const result = {
    hasSession: !!session,
    username: session.username || 'NOT SET',
    outlet: session.outlet || 'NOT SET',
    allowedTabs: session.allowedTabs || [],
    timestamp: new Date().toISOString(),
    deviceId: deviceId || 'NOT PROVIDED'
  };
  
  Logger.log("Current session info: " + JSON.stringify(result));
  return result;
}

function clearAllUserSessions(username) {
  if (!username) {
    Logger.log("clearAllUserSessions: No username provided");
    return { clearedSessions: 0, username: null, error: "No username provided" };
  }
  
  const scriptProps = PropertiesService.getScriptProperties();
  const allProps = scriptProps.getProperties();
  let clearedCount = 0;
  let keysToDelete = [];
  
  Logger.log("clearAllUserSessions: Starting cleanup for user: " + username);
  Logger.log("clearAllUserSessions: Total properties found: " + Object.keys(allProps).length);
  
  // First, find all sessions for this username - check both old and new formats
  for (const key in allProps) {
    if (key.startsWith('session_')) {
      try {
        const sessionData = JSON.parse(allProps[key]);
        Logger.log("clearAllUserSessions: Checking session " + key + " with username: " + sessionData.username);
        if (sessionData.username === username) {
          keysToDelete.push(key);
          Logger.log("clearAllUserSessions: Marking session for deletion: " + key);
        }
      } catch (error) {
        // Invalid session data, mark for deletion anyway
        keysToDelete.push(key);
        Logger.log('clearAllUserSessions: Marking invalid session for deletion: ' + key + " - Error: " + error.toString());
      }
    }
  }
  
  Logger.log("clearAllUserSessions: Found " + keysToDelete.length + " sessions to delete");
  
  // Now delete all marked sessions using deleteProperties for batch operation
  if (keysToDelete.length > 0) {
    try {
      // Try batch delete first
      scriptProps.deleteProperties(keysToDelete);
      clearedCount = keysToDelete.length;
      Logger.log("clearAllUserSessions: Batch deleted " + clearedCount + " sessions");
    } catch (batchError) {
      Logger.log("clearAllUserSessions: Batch delete failed, trying individual deletes: " + batchError.toString());
      // If batch fails, delete one by one
      keysToDelete.forEach(key => {
        try {
          scriptProps.deleteProperty(key);
          clearedCount++;
          Logger.log("clearAllUserSessions: Individually deleted session: " + key);
        } catch (deleteError) {
          Logger.log("clearAllUserSessions: Failed to delete session " + key + ": " + deleteError.toString());
        }
      });
    }
  }
  
  // Verify deletion by checking remaining sessions
  const remainingProps = scriptProps.getProperties();
  let remainingSessions = 0;
  for (const key in remainingProps) {
    if (key.startsWith('session_')) {
      try {
        const sessionData = JSON.parse(remainingProps[key]);
        if (sessionData.username === username) {
          remainingSessions++;
          Logger.log("WARNING: Session still exists after deletion: " + key);
        }
      } catch (error) {
        // Ignore parsing errors for verification
      }
    }
  }
  
  const result = { 
    clearedSessions: clearedCount, 
    username: username,
    remainingSessions: remainingSessions,
    success: remainingSessions === 0
  };
  
  Logger.log("clearAllUserSessions: Final result: " + JSON.stringify(result));
  return result;
}

function logout(deviceId) {
  Logger.log("logout: Starting logout process for deviceId: " + deviceId);
  
  // Get the current session to find the username
  let session = getUserSessionEnhanced(deviceId);
  if (!session || !session.username) {
    Logger.log("logout: No valid session found for deviceId: " + deviceId);
    
    // Even if no session found, try to clear any remaining properties
    try {
      clearUserSession(deviceId);
    } catch (error) {
      Logger.log("logout: Error during cleanup: " + error.toString());
    }
    
    return { success: false, message: "No active session found", deviceId: deviceId };
  }
  
  const username = session.username;
  Logger.log("logout: Found active session for user: " + username);
  
  // Clear all sessions for this user across all devices
  const result = clearAllUserSessions(username);
  
  // Also force clear the current device session as a backup
  try {
    const singleClearResult = clearUserSession(deviceId, username);
    Logger.log("logout: Single session clear result: " + JSON.stringify(singleClearResult));
  } catch (error) {
    Logger.log("logout: Error in single session clear: " + error.toString());
  }
  
  // Final verification - check if any sessions remain for this user
  const finalCheck = getAllActiveSessions();
  let remainingUserSessions = 0;
  for (const deviceKey in finalCheck) {
    if (finalCheck[deviceKey].username === username) {
      remainingUserSessions++;
      Logger.log("WARNING: Session still active after logout for device: " + deviceKey);
    }
  }
  
  const finalResult = {
    success: remainingUserSessions === 0,
    message: remainingUserSessions === 0 ? "Logged out from all devices" : "Partial logout - some sessions may remain",
    username: username,
    deviceId: deviceId,
    ...result,
    remainingUserSessions: remainingUserSessions
  };
  
  Logger.log("logout: Final result: " + JSON.stringify(finalResult));
  return finalResult;
}

// Test function to verify multi-device logout functionality
function testMultiDeviceLogout() {
  Logger.log("=== Testing Multi-Device Logout ===");
  
  const testUsername = "testuser";
  const testOutlet = "TestOutlet";
  const testTabs = ["orders", "deposits"];
  
  try {
    // First, clean up any existing test sessions
    clearAllUserSessions(testUsername);
    
    // Simulate login from 3 different devices
    const devices = ["device1", "device2", "device3"];
    
    // Login from all devices
    devices.forEach(deviceId => {
      login(testUsername, testOutlet, testTabs, deviceId);
      Logger.log("Logged in from device: " + deviceId);
    });
    
    // Show all sessions before logout
    Logger.log("=== Sessions before logout ===");
    const sessionsBefore = getAllActiveSessions();
    
    // Verify all sessions exist
    let activeSessions = 0;
    devices.forEach(deviceId => {
      const session = getUserSessionEnhanced(deviceId);
      if (session && session.username === testUsername) {
        activeSessions++;
        Logger.log("Confirmed active session for device: " + deviceId);
      } else {
        Logger.log("WARNING: No session found for device: " + deviceId);
      }
    });
    Logger.log("Active sessions before logout: " + activeSessions);
    
    // Logout from one device (should clear all sessions for this user)
    Logger.log("=== Performing logout from device2 ===");
    const logoutResult = logout("device2");
    Logger.log("Logout result: " + JSON.stringify(logoutResult));
    
    // Show all sessions after logout
    Logger.log("=== Sessions after logout ===");
    const sessionsAfter = getAllActiveSessions();
    
    // Verify all sessions are cleared
    let remainingSessions = 0;
    devices.forEach(deviceId => {
      const session = getUserSessionEnhanced(deviceId);
      if (session && session.username === testUsername) {
        remainingSessions++;
        Logger.log("WARNING: Session still exists for device: " + deviceId + " - " + JSON.stringify(session));
      } else {
        Logger.log("GOOD: No session found for device: " + deviceId);
      }
    });
    Logger.log("Remaining sessions after logout: " + remainingSessions);
    
    // Additional verification - check script properties directly
    const scriptProps = PropertiesService.getScriptProperties();
    const allProps = scriptProps.getProperties();
    let directSessionCount = 0;
    for (const key in allProps) {
      if (key.startsWith('session_')) {
        try {
          const sessionData = JSON.parse(allProps[key]);
          if (sessionData.username === testUsername) {
            directSessionCount++;
            Logger.log("WARNING: Direct property check found session: " + key);
          }
        } catch (error) {
          // Ignore parsing errors
        }
      }
    }
    
    const result = {
      activeSessionsBeforeLogout: activeSessions,
      remainingSessionsAfterLogout: remainingSessions,
      directPropertySessionCount: directSessionCount,
      logoutResult: logoutResult,
      success: remainingSessions === 0 && directSessionCount === 0,
      sessionsBefore: sessionsBefore,
      sessionsAfter: sessionsAfter
    };
    
    Logger.log("=== Test Summary ===");
    Logger.log("Test result: " + JSON.stringify(result, null, 2));
    return result;
    
  } catch (error) {
    Logger.log("Test failed: " + error.toString());
    return { error: error.toString() };
  }
}

// Comprehensive test function that doesn't require parameters (for easier debugging)
function testSessionSystem() {
  Logger.log("=== Comprehensive Session System Test ===");
  
  const testDeviceId = "test_device_" + new Date().getTime();
  const testUsername = "testuser";
  const testOutlet = "TestOutlet";
  const testTabs = ["orders", "deposits"];
  
  try {
    // Clean up any existing test sessions first
    clearAllUserSessions(testUsername);
    
    // Test 1: Login
    Logger.log("--- Test 1: Login ---");
    login(testUsername, testOutlet, testTabs, testDeviceId);
    Logger.log("Login completed for device: " + testDeviceId);
    
    // Test 2: Session retrieval with deviceId
    Logger.log("--- Test 2: Device-based session retrieval ---");
    const deviceSession = getUserSessionEnhanced(testDeviceId);
    Logger.log("Device-based session: " + JSON.stringify(deviceSession));
    
    // Test 3: Debug functions
    Logger.log("--- Test 3: Debug functions ---");
    const debugDevice = debugSessionState(testDeviceId, testUsername);
    Logger.log("Device debug result: " + JSON.stringify(debugDevice));
    
    // Test 4: Session info functions
    Logger.log("--- Test 4: Session info functions ---");
    const deviceInfo = getCurrentSessionInfo(testDeviceId, testUsername);
    Logger.log("Device info: " + JSON.stringify(deviceInfo));
    
    // Test 5: Logout
    Logger.log("--- Test 5: Logout ---");
    const logoutResult = logout(testDeviceId);
    Logger.log("Logout result: " + JSON.stringify(logoutResult));
    
    // Test 6: Verify cleanup
    Logger.log("--- Test 6: Verify cleanup ---");
    const afterLogout = getUserSessionEnhanced(testDeviceId);
    Logger.log("Session after logout (should be null): " + JSON.stringify(afterLogout));
    
    const result = {
      loginSuccess: true,
      deviceSession: deviceSession,
      debugDevice: debugDevice,
      logoutResult: logoutResult,
      cleanupVerified: !afterLogout,
      success: true
    };
    
    Logger.log("=== Test Summary ===");
    Logger.log("Test result: " + JSON.stringify(result, null, 2));
    return result;
    
  } catch (error) {
    Logger.log("Test failed: " + error.toString());
    Logger.log("Error stack: " + error.stack);
    
    // Try to clean up even if test failed
    try {
      clearAllUserSessions(testUsername);
    } catch (cleanupError) {
      Logger.log("Cleanup also failed: " + cleanupError.toString());
    }
    
    return { 
      success: false, 
      error: error.toString(),
      stack: error.stack 
    };
  }
}

// Function to check all active sessions (for debugging)
function getAllActiveSessions() {
  const scriptProps = PropertiesService.getScriptProperties();
  const allProps = scriptProps.getProperties();
  const activeSessions = {};
  
  for (const key in allProps) {
    if (key.startsWith('session_')) {
      try {
        const sessionData = JSON.parse(allProps[key]);
        const deviceId = key.replace('session_', '');
        activeSessions[deviceId] = {
          username: sessionData.username,
          outlet: sessionData.outlet,
          loginTime: new Date(sessionData.loginTime).toISOString(),
          lastActivity: new Date(sessionData.lastActivity).toISOString()
        };
      } catch (error) {
        Logger.log('Invalid session data for key: ' + key);
      }
    }
  }
  
  Logger.log("All active sessions: " + JSON.stringify(activeSessions, null, 2));
  return activeSessions;
}

// Nuclear option - force clear all sessions for debugging
function forceCleanAllSessions() {
  Logger.log("=== FORCE CLEANING ALL SESSIONS ===");
  
  const scriptProps = PropertiesService.getScriptProperties();
  const allProps = scriptProps.getProperties();
  let deletedCount = 0;
  const keysToDelete = [];
  
  // Find all session keys
  for (const key in allProps) {
    if (key.startsWith('session_')) {
      keysToDelete.push(key);
    }
  }
  
  Logger.log("Found " + keysToDelete.length + " session keys to delete");
  
  // Try batch delete first
  if (keysToDelete.length > 0) {
    try {
      scriptProps.deleteProperties(keysToDelete);
      deletedCount = keysToDelete.length;
      Logger.log("Batch deleted " + deletedCount + " sessions");
    } catch (batchError) {
      Logger.log("Batch delete failed, trying individual: " + batchError.toString());
      // Individual delete as fallback
      keysToDelete.forEach(key => {
        try {
          scriptProps.deleteProperty(key);
          deletedCount++;
          Logger.log("Individually deleted: " + key);
        } catch (error) {
          Logger.log("Failed to delete: " + key + " - " + error.toString());
        }
      });
    }
  }
  
  // Verify cleanup
  const remainingProps = scriptProps.getProperties();
  let remainingSessions = 0;
  for (const key in remainingProps) {
    if (key.startsWith('session_')) {
      remainingSessions++;
    }
  }
  
  const result = {
    deleted: deletedCount,
    remaining: remainingSessions,
    success: remainingSessions === 0
  };
  
  Logger.log("Force clean result: " + JSON.stringify(result));
  return result;
}

// Function to manually verify and fix session deletion issues
function debugSessionDeletion(username) {
  Logger.log("=== DEBUGGING SESSION DELETION ===");
  Logger.log("Target username: " + username);
  
  const scriptProps = PropertiesService.getScriptProperties();
  const allProps = scriptProps.getProperties();
  
  Logger.log("Total properties: " + Object.keys(allProps).length);
  
  const sessionKeys = [];
  const targetSessions = [];
  
  for (const key in allProps) {
    if (key.startsWith('session_')) {
      sessionKeys.push(key);
      try {
        const sessionData = JSON.parse(allProps[key]);
        if (sessionData.username === username) {
          targetSessions.push(key);
          Logger.log("Found target session: " + key + " - " + JSON.stringify(sessionData));
        }
      } catch (error) {
        Logger.log("Invalid session data for: " + key);
        targetSessions.push(key); // Include invalid sessions for cleanup
      }
    }
  }
  
  Logger.log("Total session keys: " + sessionKeys.length);
  Logger.log("Target sessions to delete: " + targetSessions.length);
  
  // Try to delete each target session individually and verify
  const deletionResults = [];
  targetSessions.forEach(key => {
    try {
      // Check if exists before deletion
      const beforeDelete = scriptProps.getProperty(key);
      Logger.log("Before delete - " + key + ": " + (beforeDelete ? "EXISTS" : "NOT_FOUND"));
      
      // Delete
      scriptProps.deleteProperty(key);
      
      // Verify deletion
      const afterDelete = scriptProps.getProperty(key);
      const deleted = !afterDelete;
      
      deletionResults.push({
        key: key,
        deleted: deleted,
        beforeDelete: !!beforeDelete,
        afterDelete: !!afterDelete
      });
      
      Logger.log("After delete - " + key + ": " + (deleted ? "DELETED" : "STILL_EXISTS"));
      
    } catch (error) {
      Logger.log("Error deleting " + key + ": " + error.toString());
      deletionResults.push({
        key: key,
        deleted: false,
        error: error.toString()
      });
    }
  });
  
  return {
    totalProperties: Object.keys(allProps).length,
    totalSessions: sessionKeys.length,
    targetSessions: targetSessions.length,
    deletionResults: deletionResults,
    username: username
  };
}

// Helper function to find session by deviceId when username is not known
function findSessionByDeviceId(deviceId) {
  if (!deviceId) return null;
  
  const scriptProps = PropertiesService.getScriptProperties();
  const allProps = scriptProps.getProperties();
  
  // Look for any session key that ends with the deviceId
  for (const key in allProps) {
    if (key.startsWith('session_') && key.endsWith('_' + deviceId)) {
      try {
        const sessionData = JSON.parse(allProps[key]);
        if (sessionData.deviceId === deviceId) {
          return {
            sessionKey: key,
            sessionData: sessionData,
            username: sessionData.username
          };
        }
      } catch (error) {
        Logger.log('Invalid session data for key: ' + key);
      }
    }
    // Also check old format sessions
    else if (key === 'session_' + deviceId) {
      try {
        const sessionData = JSON.parse(allProps[key]);
        return {
          sessionKey: key,
          sessionData: sessionData,
          username: sessionData.username
        };
      } catch (error) {
        Logger.log('Invalid session data for old format key: ' + key);
      }
    }
  }
  
  return null;
}

function userSuffixForDeviceId_(username) {
  return '_user_' + String(username || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function usernamesMatchForSession_(a, b) {
  if (!a || !b) return false;
  return String(a).trim() === String(b).trim() ||
    String(a).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() ===
    String(b).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

var SESSION_TOUCH_MS = 60000;
var SESSION_PEOPLE_REFRESH_MS = 300000;

function sessionSummaryFromData_(sessionData) {
  return {
    username: sessionData.username,
    outlet: sessionData.outlet,
    allowedTabs: sessionData.allowedTabs || [],
    role: sessionData.role || 'cashier'
  };
}

/** Throttle ScriptProperties writes and People sheet reads on hot paths (e.g. order save). */
function maybeTouchUserSession_(sessionKey, sessionData, username, options) {
  options = options || {};
  var now = Date.now();
  var touchMs = options.touchMs != null ? options.touchMs : SESSION_TOUCH_MS;
  var skipPeople = !!options.skipPeopleRefresh;
  var lastTouch = sessionData._lastPersist || sessionData.lastActivity || 0;
  var lastPeople = sessionData._peopleRefresh || 0;
  var needsPeople = !skipPeople && (now - lastPeople) >= SESSION_PEOPLE_REFRESH_MS;
  var needsTouch = (now - lastTouch) >= touchMs;

  if (needsPeople && typeof refreshSessionAuthFromPeople_ === 'function') {
    sessionData = refreshSessionAuthFromPeople_(username, sessionData) || sessionData;
    sessionData._peopleRefresh = now;
    needsTouch = true;
  }

  if (needsTouch) {
    sessionData.lastActivity = now;
    sessionData._lastPersist = now;
    PropertiesService.getScriptProperties().setProperty(sessionKey, JSON.stringify(sessionData));
  }

  return sessionData;
}

// Enhanced getUserSession that can work with just deviceId by searching for the session
function getUserSessionEnhanced(deviceId, username, options) {
  options = options || {};
  if (!deviceId) {
    Logger.log("getUserSessionEnhanced: No deviceId provided");
    return null;
  }
  
  // If we have username, use the direct approach (inline the logic)
  if (username) {
    var expectedUserSuffix = userSuffixForDeviceId_(username);
    if (!deviceId.endsWith(expectedUserSuffix)) {
      Logger.log('SECURITY: Device ID suffix mismatch. DeviceId: ' + deviceId + ', Expected suffix: ' + expectedUserSuffix);
      var byDevice = findSessionByDeviceId(deviceId);
      if (!byDevice || !usernamesMatchForSession_(byDevice.username, username)) {
        return null;
      }
      username = byDevice.username;
    }
    
    const scriptProps = PropertiesService.getScriptProperties();
    var resolvedSessionKey = 'session_' + username + '_' + deviceId;
    var sessionJson = scriptProps.getProperty(resolvedSessionKey);
    
    if (!sessionJson) {
      var found = findSessionByDeviceId(deviceId);
      if (found && usernamesMatchForSession_(found.username, username)) {
        resolvedSessionKey = found.sessionKey;
        sessionJson = scriptProps.getProperty(found.sessionKey);
        username = found.username;
        Logger.log('Session recovered via deviceId lookup: ' + found.sessionKey);
      }
    }
    
    if (!sessionJson) {
      Logger.log('Session not found for key: session_' + username + '_' + deviceId);
      return null;
    }
    
    try {
      var sessionData = JSON.parse(sessionJson);
      
      // Additional validation: Ensure the session username matches the request
      if (!usernamesMatchForSession_(sessionData.username, username)) {
        Logger.log('SECURITY VIOLATION: Session username mismatch. Session: ' + sessionData.username + ', Request: ' + username);
        return null;
      }
      
      username = sessionData.username;
      
      // Check if session is expired (24 hours)
      const now = new Date().getTime();
      const sessionAge = now - sessionData.lastActivity;
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
      
      if (sessionAge > maxAge) {
        // Session expired, clear it
        clearUserSession(deviceId, username);
        return null;
      }
      
      sessionData = maybeTouchUserSession_(resolvedSessionKey, sessionData, username, options);
      return sessionSummaryFromData_(sessionData);
    } catch (error) {
      console.error('Error parsing session data:', error);
      return null;
    }
  }
  
  // If no username, search for the session
  const sessionInfo = findSessionByDeviceId(deviceId);
  if (sessionInfo) {
    // Check session expiry
    const now = new Date().getTime();
    const sessionAge = now - sessionInfo.sessionData.lastActivity;
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    if (sessionAge > maxAge) {
      // Session expired, clear it
      clearUserSession(deviceId, sessionInfo.username);
      return null;
    }
    
    sessionInfo.sessionData = maybeTouchUserSession_(
      sessionInfo.sessionKey,
      sessionInfo.sessionData,
      sessionInfo.username,
      options
    );
    return sessionSummaryFromData_(sessionInfo.sessionData);
  }
  
  return null;
}

// Test function specifically for the new session key format with username
function testImprovedSessionSystem() {
  Logger.log("=== Testing Improved Session System with Username Keys ===");
  
  const testDeviceId = "device_" + new Date().getTime();
  const testUsername1 = "user1_outlet_A";
  const testUsername2 = "user2_outlet_B";
  const testOutlet1 = "Outlet_A";
  const testOutlet2 = "Outlet_B";
  const testTabs = ["orders", "deposits"];
  
  try {
    // Clean up first
    clearAllUserSessions(testUsername1);
    clearAllUserSessions(testUsername2);
    
    Logger.log("--- Creating sessions for two users with same deviceId but different outlets ---");
    
    // Login user 1 with outlet A
    login(testUsername1, testOutlet1, testTabs, testDeviceId);
    Logger.log("User 1 logged in");
    
    // Login user 2 with outlet B (same device, different user/outlet)
    login(testUsername2, testOutlet2, testTabs, testDeviceId);
    Logger.log("User 2 logged in");
    
    // Test session retrieval with specific user
    Logger.log("--- Testing session retrieval with username specification ---");
    const session1 = getUserSessionEnhanced(testDeviceId, testUsername1);
    const session2 = getUserSessionEnhanced(testDeviceId, testUsername2);
    
    Logger.log("Session 1 (should be outlet A): " + JSON.stringify(session1));
    Logger.log("Session 2 (should be outlet B): " + JSON.stringify(session2));
    
    // Test backward compatibility - should find a session but which one?
    Logger.log("--- Testing backward compatibility (no username specified) ---");
    const fallbackSession = getUserSessionEnhanced(testDeviceId);
    Logger.log("Fallback session (could be either): " + JSON.stringify(fallbackSession));
    
    // Verify outlet isolation
    const success = session1 && session1.outlet === testOutlet1 && 
                   session2 && session2.outlet === testOutlet2 &&
                   session1.outlet !== session2.outlet;
    
    Logger.log("--- Test Results ---");
    Logger.log("Session isolation successful: " + success);
    Logger.log("User 1 outlet: " + (session1 ? session1.outlet : 'NULL'));
    Logger.log("User 2 outlet: " + (session2 ? session2.outlet : 'NULL'));
    
    // Clean up
    clearAllUserSessions(testUsername1);
    clearAllUserSessions(testUsername2);
    
    return {
      success: success,
      session1: session1,
      session2: session2,
      fallbackSession: fallbackSession,
      outletIsolation: session1 && session2 && session1.outlet !== session2.outlet
    };
    
  } catch (error) {
    Logger.log("Test failed: " + error.toString());
    return { success: false, error: error.toString() };
  }
}

// Function to migrate existing sessions to new format (if needed)
function migrateSessionsToNewFormat() {
  Logger.log("=== Migrating Sessions to New Format ===");
  
  const scriptProps = PropertiesService.getScriptProperties();
  const allProps = scriptProps.getProperties();
  let migratedCount = 0;
  let errors = [];
  
  for (const key in allProps) {
    // Look for old format sessions
    if (key.startsWith('session_') && !key.includes('_', 8)) { // Simple check for old format
      try {
        const sessionData = JSON.parse(allProps[key]);
        if (sessionData.username && sessionData.deviceId) {
          // Create new format key
          const newKey = 'session_' + sessionData.username + '_' + sessionData.deviceId;
          
          // Copy to new key
          scriptProps.setProperty(newKey, allProps[key]);
          
          // Verify copy
          const verifyData = scriptProps.getProperty(newKey);
          if (verifyData) {
            // Remove old key
            scriptProps.deleteProperty(key);
            migratedCount++;
            Logger.log("Migrated session: " + key + " -> " + newKey);
          } else {
            errors.push("Failed to verify migration of: " + key);
          }
        }
      } catch (error) {
        errors.push("Error migrating " + key + ": " + error.toString());
      }
    }
  }
  
  const result = {
    migratedCount: migratedCount,
    errors: errors,
    success: errors.length === 0
  };
  
  Logger.log("Migration result: " + JSON.stringify(result));
  return result;
}

// Main function to be used throughout the system - automatically handles username+deviceId session lookup
function getActiveUserSession(deviceId, username) {
  // This is the main function that should be called from other parts of the system
  // It ensures proper outlet isolation by using username in the session key
  
  if (!deviceId) {
    Logger.log("getActiveUserSession: No deviceId provided");
    return null;
  }
  
  if (username) {
    // Direct lookup with username - most secure and reliable
    return getUserSessionEnhanced(deviceId, username);
  } else {
    // Enhanced lookup that searches for the session
    return getUserSessionEnhanced(deviceId);
  }
}

// Helper function to validate that a session belongs to the expected outlet
function validateSessionOutlet(session, expectedOutlet) {
  if (!session || !session.outlet) {
    return false;
  }
  return session.outlet === expectedOutlet;
}

// Function to be called when outlet data mixing is detected
function debugOutletDataMixing(deviceId, expectedOutlet, actualData) {
  Logger.log("=== OUTLET DATA MIXING DETECTED ===");
  Logger.log("Device ID: " + deviceId);
  Logger.log("Expected Outlet: " + expectedOutlet);
  Logger.log("Actual Data Outlet: " + (actualData ? actualData.outlet || 'UNKNOWN' : 'NO DATA'));
  
  // Get current session info
  const session = getUserSessionEnhanced(deviceId);
  Logger.log("Current Session: " + JSON.stringify(session));
  
  // Get all active sessions to see if there are conflicts
  const allSessions = getAllActiveSessions();
  Logger.log("All Active Sessions: " + JSON.stringify(allSessions));
  
  // Look for sessions with the same deviceId but different outlets
  const conflictingSessions = [];
  for (const sessDeviceId in allSessions) {
    if (sessDeviceId !== deviceId && allSessions[sessDeviceId].outlet !== expectedOutlet) {
      conflictingSessions.push({
        deviceId: sessDeviceId,
        outlet: allSessions[sessDeviceId].outlet,
        username: allSessions[sessDeviceId].username
      });
    }
  }
  
  return {
    deviceId: deviceId,
    expectedOutlet: expectedOutlet,
    currentSession: session,
    allSessions: allSessions,
    conflictingSessions: conflictingSessions,
    hasConflicts: conflictingSessions.length > 0
  };
}

// Simple test to verify the outlet isolation fix
function testOutletIsolation() {
  Logger.log("=== Testing Outlet Isolation Fix ===");
  
  const deviceId = "shared_device_123";
  const user1 = "alice_outletA";
  const user2 = "bob_outletB";
  const outlet1 = "Outlet_A";
  const outlet2 = "Outlet_B";
  const tabs = ["orders", "sales"];
  
  try {
    // Clean up first
    clearAllUserSessions(user1);
    clearAllUserSessions(user2);
    
    // Step 1: User 1 logs in from outlet A
    Logger.log("1. User 1 (Alice) logs in from Outlet A");
    login(user1, outlet1, tabs, deviceId);
    
    // Verify user 1 session
    const session1 = getUserSessionEnhanced(deviceId, user1);
    Logger.log("User 1 session: " + JSON.stringify(session1));
    
    // Step 2: User 2 logs in from outlet B (same device!)
    Logger.log("2. User 2 (Bob) logs in from Outlet B on same device");
    login(user2, outlet2, tabs, deviceId);
    
    // Verify user 2 session
    const session2 = getUserSessionEnhanced(deviceId, user2);
    Logger.log("User 2 session: " + JSON.stringify(session2));
    
    // Step 3: Verify both sessions exist and have correct outlets
    const user1Valid = session1 && session1.outlet === outlet1;
    const user2Valid = session2 && session2.outlet === outlet2;
    const outletsIsolated = session1.outlet !== session2.outlet;
    
    Logger.log("3. Verification:");
    Logger.log("   User 1 has correct outlet: " + user1Valid);
    Logger.log("   User 2 has correct outlet: " + user2Valid);
    Logger.log("   Outlets are isolated: " + outletsIsolated);
    
    // Step 4: Test enhanced call (without username) - should find one of them
    const legacySession = getUserSessionEnhanced(deviceId);
    Logger.log("4. Enhanced call result: " + JSON.stringify(legacySession));
    
    const testPassed = user1Valid && user2Valid && outletsIsolated;
    
    // Clean up
    clearAllUserSessions(user1);
    clearAllUserSessions(user2);
    
    Logger.log("=== Test Result: " + (testPassed ? "PASSED" : "FAILED") + " ===");
    
    return {
      testPassed: testPassed,
      user1Session: session1,
      user2Session: session2,
      legacySession: legacySession,
      outletsIsolated: outletsIsolated
    };
    
  } catch (error) {
    Logger.log("Test failed with error: " + error.toString());
    return { testPassed: false, error: error.toString() };
  }
}

// Clear all sessions and properties for a specific user
function clearAllUserSessionsAndProperties(username) {
  if (!username) {
    Logger.log("clearAllUserSessionsAndProperties: No username provided");
    return { success: false, error: "Username is required" };
  }
  
  Logger.log("clearAllUserSessionsAndProperties: Clearing all sessions for user: " + username);
  
  const scriptProps = PropertiesService.getScriptProperties();
  let clearedCount = 0;
  let errors = [];
  
  try {
    // Get all properties to find user-specific sessions
    const allProps = scriptProps.getProperties();
    
    // Clear all session properties for this user
    for (const key in allProps) {
      if (key.startsWith('session_' + username + '_')) {
        try {
          scriptProps.deleteProperty(key);
          clearedCount++;
          Logger.log("clearAllUserSessionsAndProperties: Cleared session: " + key);
        } catch (error) {
          errors.push("Failed to clear session " + key + ": " + error.toString());
          Logger.log("clearAllUserSessionsAndProperties: Error clearing session " + key + ": " + error.toString());
        }
      }
    }
    
    // Clear user devices tracking
    const userDeviceKey = 'user_devices_' + username;
    try {
      const existingDevices = scriptProps.getProperty(userDeviceKey);
      if (existingDevices) {
        scriptProps.deleteProperty(userDeviceKey);
        Logger.log("clearAllUserSessionsAndProperties: Cleared user devices list: " + userDeviceKey);
      }
    } catch (error) {
      errors.push("Failed to clear user devices list: " + error.toString());
      Logger.log("clearAllUserSessionsAndProperties: Error clearing user devices list: " + error.toString());
    }
    
    // Clear legacy UserProperties if they belong to this user
    try {
      const userProps = PropertiesService.getUserProperties();
      const legacyUsername = userProps.getProperty('username');
      if (legacyUsername === username) {
        userProps.deleteProperties(['username', 'outlet', 'allowedTabs']);
        Logger.log("clearAllUserSessionsAndProperties: Cleared legacy properties for user: " + username);
      }
    } catch (legacyError) {
      errors.push("Failed to clear legacy properties: " + legacyError.toString());
      Logger.log("clearAllUserSessionsAndProperties: Error clearing legacy properties: " + legacyError.toString());
      
      // Try individual deletions as fallback
      try {
        const userProps = PropertiesService.getUserProperties();
        const legacyUsername = userProps.getProperty('username');
        if (legacyUsername === username) {
          userProps.deleteProperty('username');
          userProps.deleteProperty('outlet');
          userProps.deleteProperty('allowedTabs');
          Logger.log("clearAllUserSessionsAndProperties: Individually cleared legacy properties for user: " + username);
        }
      } catch (individualError) {
        errors.push("Failed to individually clear legacy properties: " + individualError.toString());
        Logger.log("clearAllUserSessionsAndProperties: Failed to individually clear legacy properties: " + individualError.toString());
      }
    }
    
    Logger.log("clearAllUserSessionsAndProperties: Successfully cleared " + clearedCount + " sessions for user: " + username);
    
    return { 
      success: true, 
      username: username, 
      clearedSessionCount: clearedCount, 
      errors: errors.length > 0 ? errors : null 
    };
    
  } catch (error) {
    Logger.log("clearAllUserSessionsAndProperties: Critical error: " + error.toString());
    return { 
      success: false, 
      error: "Critical error while clearing sessions: " + error.toString(), 
      username: username 
    };
  }
}