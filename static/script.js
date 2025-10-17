// Global variables
let map;
let myLocation = null;
let userMarker = null; // Used for the local Blue/Red marker (always visible to self)
let showMyLocation = false; // Initial state is false
let isHelping = false; // Tracks if the current user needs help

let otherUsersMarkers = {};           // { username: { marker, helping, showLocation } }
let activeHelpNotifications = {};    // { needyUsername: { message, color, responded } } 
let activeLines = {};                 // { needyUsername: [polylines] }

// 🟢 FIX: Global variable to manage the polling interval ID for synchronization
let alertIntervalId; 

// Utility: Calculate distance between two lat/lng points in km
function getDistance(lat1, lng1, lat2, lng2) {
    const toRad = v => v * Math.PI / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Module 1: Initialize map and user location
function initMap() {
    map = L.map("map").setView([20.5937, 78.9629], 5);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
    }).addTo(map);

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                updateUserMarker();
                
                // Tell the server to disable sharing immediately (important for initial state)
                removeSharedLocation(); 
            },
            (err) => {
                console.error("Geolocation error:", err);
                alert("Geolocation permission denied or unavailable.");
            }
        );
    } else {
        alert("Geolocation not supported.");
    }

    document.getElementById("helpMeBtn").style.backgroundColor = "#f39c12";
    document.getElementById("showLocationBtn").style.backgroundColor = "#16a085";

    // 🟢 Start the primary polling loop and store its ID
    alertIntervalId = setInterval(fetchAlerts, 3000); 
}

// Update user marker (blue or red pulsating) - This is the default 'self' marker
function updateUserMarker() {
    if (!myLocation) return;
    if (userMarker) map.removeLayer(userMarker);

    let icon;
    if (isHelping) {
        icon = L.divIcon({ className: 'help-marker' });
    } else {
        icon = L.icon({
            iconUrl: "https://unpkg.com/leaflet/dist/images/marker-icon.png",
            iconRetinaUrl: "https://unpkg.com/leaflet/dist/images/marker-icon-2x.png",
            shadowUrl: "https://unpkg.com/leaflet/dist/images/marker-shadow.png",
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        });
    }

    userMarker = L.marker([myLocation.lat, myLocation.lng], { icon, title: username }).addTo(map);
    userMarker.bindPopup(isHelping ? "You need help!" : "You");
    map.setView([myLocation.lat, myLocation.lng], 12);
}

// Module 2: Send / remove shared location
function sendLocationUpdate() {
    if (!myLocation) return;
    // Sends the current state of showMyLocation (true/false)
    fetch("/update_location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, lat: myLocation.lat, lng: myLocation.lng, showLocation: showMyLocation }),
    });
}

// Function to tell the server to stop broadcasting location
function removeSharedLocation() {
    // Sends a request to clear the server's record for this user's shared location
    fetch("/remove_location", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username })
    })
    .catch(console.error);
}

function addOrUpdateUserMarker(uName, lat, lng, helping, showLocation) {
    // 🟢 FIX: Exclude the local user from displaying their own green marker.
    if (uName === username) return;

    if (otherUsersMarkers[uName]) map.removeLayer(otherUsersMarkers[uName].marker);

    let icon;
    if (helping) {
        icon = L.divIcon({ className: 'help-marker' });
    } else if (showLocation) {
        // Green dot marker (static)
        icon = L.divIcon({ 
            className: 'green-dot-marker',
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        });
    } else {
        // DISAPPEARANCE LOGIC: If showLocation is false, remove the marker
        if (otherUsersMarkers[uName]) {
            map.removeLayer(otherUsersMarkers[uName].marker);
            delete otherUsersMarkers[uName];
        }
        return;
    }

    let marker = L.marker([lat, lng], { icon }).addTo(map);
    marker.bindPopup(helping ? `${uName} needs help!` : uName);

    otherUsersMarkers[uName] = { marker, helping, showLocation };
}

// Persistent notifications
function addOrUpdatePersistentNotification(id, message, color) {
    let item = document.getElementById(id);
    const notificationsDiv = document.getElementById("notifications");
    if (!item) {
        item = document.createElement("div");
        item.className = `popup-item ${color}`;
        item.id = id;
        item.innerHTML = `<strong>${message}</strong>`;
        notificationsDiv.appendChild(item);
    } else {
        item.querySelector("strong").textContent = message;
    }
}

function removePersistentNotification(id) {
    const item = document.getElementById(id);
    if(item) item.remove();
}

// Module 3: Help Me toggle
document.getElementById("helpMeBtn").addEventListener("click", () => {
    if (!myLocation) return alert("Location not available.");

    isHelping = !isHelping;
    document.getElementById("helpMeBtn").style.backgroundColor = isHelping ? "#e74c3c" : "#f39c12";

    updateUserMarker();
    sendHelpAlert(isHelping);

    if (isHelping) {
        const nearbyUsers = Object.keys(otherUsersMarkers).filter(u => {
            if (!myLocation) return false;
            const dist = getDistance(myLocation.lat, myLocation.lng,
                otherUsersMarkers[u].marker.getLatLng().lat,
                otherUsersMarkers[u].marker.getLatLng().lng);
            return dist <= 1;
        });

        addOrUpdatePersistentNotification("helpNotif",
            `You need help! Location shared to ${nearbyUsers.length} users within 1 km.`, "red");
    } else {
        removePersistentNotification("helpNotif");
        fetch("/notify_safe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username })
        });
        document.getElementById("notifications").querySelectorAll('[id^="needy-helper-"]').forEach(item => item.remove());
    }
});

function sendHelpAlert(helping) {
    fetch("/send_alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, lat: myLocation.lat, lng: myLocation.lng, helping }),
    });
}

// Module 4: Fetch alerts, update map and notifications
function fetchAlerts() {
    fetch("/get_alerts")
        .then(res => res.json())
        .then(alerts => {
            Object.keys(activeHelpNotifications).forEach(key => {
                if (!alerts.some(a => a.username === key && a.helping)) {
                    removeNotification(key);
                    if(activeLines[key]) {
                        activeLines[key].forEach(line => map.removeLayer(line));
                        delete activeLines[key];
                    }
                }
            });

            const myAlert = alerts.find(a => a.username === username);

            if (isHelping && myAlert && myAlert.activeHelpers) {
                const helperUsernames = myAlert.activeHelpers.map(h => h.helper);
                document.getElementById("notifications").querySelectorAll('[id^="needy-helper-"]').forEach(item => {
                    const helperNameFromId = item.id.replace('needy-helper-', '');
                    if (!helperUsernames.includes(helperNameFromId)) item.remove();
                });
                myAlert.activeHelpers.forEach(helperData => {
                    const message = `Helper ${helperData.helper} is coming. Distance: ${helperData.distance} km`;
                    addOrUpdateNeedyNotification(helperData.helper, message);
                });
            } else if (isHelping && !myAlert?.activeHelpers) {
                document.getElementById("notifications").querySelectorAll('[id^="needy-helper-"]').forEach(item => item.remove());
            }

            alerts.forEach(alert => {
                const { username: uName, lat, lng, helping, showLocation } = alert;
                
                addOrUpdateUserMarker(uName, lat, lng, helping, showLocation);

                if (helping && uName !== username) { // Notifications are still only for other users
                    const distance = myLocation ? getDistance(myLocation.lat, myLocation.lng, lat, lng).toFixed(2) : 0;
                    if (!activeHelpNotifications[uName]) {
                        activeHelpNotifications[uName] = {
                            message: `${uName} needs help! Distance: ${distance} km`,
                            color: "red",
                            responded: false
                        };
                        addHelpNotification(uName, activeHelpNotifications[uName]);
                    } else {
                        if (!activeHelpNotifications[uName].responded) {
                            activeHelpNotifications[uName].message = `${uName} needs help! Distance: ${distance} km`;
                        } else {
                            activeHelpNotifications[uName].message = `You are helping ${uName}. Distance: ${distance} km`;
                        }
                        updateHelpNotification(uName);
                    }
                }
            });
        })
        .catch(err => console.error("Error fetching alerts:", err));
}

function addHelpNotification(uName, notif) {
    const notificationsDiv = document.getElementById("notifications");
    if (document.getElementById(`notif-${uName}`)) return;

    const item = document.createElement("div");
    item.className = `popup-item ${notif.color}`;
    item.id = `notif-${uName}`;
    item.innerHTML = `<strong>${notif.message}</strong>`;

    const helpBtn = document.createElement("button");
    helpBtn.textContent = "Help";
    helpBtn.style.marginTop = "5px";
    helpBtn.addEventListener("click", () => respondToHelp(uName));
    item.appendChild(helpBtn);

    notificationsDiv.appendChild(item);
}

function updateHelpNotification(uName) {
    const item = document.getElementById(`notif-${uName}`);
    if(item) {
        item.querySelector("strong").textContent = activeHelpNotifications[uName].message;
        item.classList.remove("red", "blue");
        item.classList.add(activeHelpNotifications[uName].color);
    }
}

function removeNotification(uName) {
    const item = document.getElementById(`notif-${uName}`);
    if(item) item.remove();
    delete activeHelpNotifications[uName];
}

function respondToHelp(needyUsername) {
    if (!otherUsersMarkers[needyUsername]) return;

    const needyLatLng = otherUsersMarkers[needyUsername].marker.getLatLng();
    const distance = myLocation ? getDistance(myLocation.lat, myLocation.lng, needyLatLng.lat, needyLatLng.lng).toFixed(2) : 0;

    fetch("/send_response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ helper: username, needy: needyUsername, lat: myLocation.lat, lng: myLocation.lng })
    }).then(res => res.json())
      .then(data => console.log("Helper response recorded:", data));

    if (activeLines[needyUsername]) {
        activeLines[needyUsername].forEach(line => map.removeLayer(line));
        activeLines[needyUsername] = [];
    } else {
        activeLines[needyUsername] = [];
    }

    const line = L.polyline([[myLocation.lat, myLocation.lng], [needyLatLng.lat, needyLatLng.lng]], {
        color: 'blue',
        dashArray: '5,10'
    }).addTo(map);
    activeLines[needyUsername].push(line);

    const helperNotifItem = document.getElementById(`notif-${needyUsername}`);
    if (helperNotifItem) {
        if (activeHelpNotifications[needyUsername]) {
            activeHelpNotifications[needyUsername].responded = true;
            activeHelpNotifications[needyUsername].color = "blue";
            activeHelpNotifications[needyUsername].message = `You are helping ${needyUsername}. Distance: ${distance} km`;
        }

        helperNotifItem.querySelector("strong").textContent = activeHelpNotifications[needyUsername].message;
        helperNotifItem.classList.remove("red");
        helperNotifItem.classList.add("blue");
        
        const btn = helperNotifItem.querySelector("button");
        if (btn) btn.remove();
    }

    sendHelperNotificationToNeedy(needyUsername, username, distance);
}

function updateHelperDistances() {
    Object.keys(activeLines).forEach(needyUsername => {
        const helperNotifItem = document.getElementById(`notif-${needyUsername}`);
        if (helperNotifItem) {
            const helperLatLng = myLocation;
            const needyLatLng = otherUsersMarkers[needyUsername]?.marker.getLatLng();
            if (!needyLatLng || !helperLatLng) return;
            const distance = getDistance(helperLatLng.lat, helperLatLng.lng, needyLatLng.lat, needyLatLng.lng).toFixed(2);
            if (activeHelpNotifications[needyUsername]?.responded) {
                activeHelpNotifications[needyUsername].message = `You are helping ${needyUsername}. Distance: ${distance} km`;
                helperNotifItem.querySelector("strong").textContent = activeHelpNotifications[needyUsername].message;
            }
            sendHelperNotificationToNeedy(needyUsername, username, distance);
        }
    });
}

function sendHelperNotificationToNeedy(needyUsername, helperName, distance) {
    fetch("/notify_needy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ needy: needyUsername, helper: helperName, distance })
    });
}

function addOrUpdateNeedyNotification(helperName, message) {
    let id = `needy-helper-${helperName}`;
    let item = document.getElementById(id);
    const notificationsDiv = document.getElementById("notifications");
    if(!item) {
        item = document.createElement("div");
        item.className = "popup-item blue";
        item.id = id;
        item.innerHTML = `<strong>${message}</strong>`;
        notificationsDiv.appendChild(item);
    } else {
        item.querySelector("strong").textContent = message;
    }
}

document.getElementById("showLocationBtn").addEventListener("click", () => {
    if (!myLocation) return alert("Location not available.");
    
    // Toggle the state
    showMyLocation = !showMyLocation;
    
    document.getElementById("showLocationBtn").style.backgroundColor = showMyLocation ? "#2ecc71" : "#16a085";

    // 🟢 SYNCHRONIZATION FIX: Clear interval to stop premature fetching
    clearInterval(alertIntervalId);
    
    if (showMyLocation) {
        // 🟢 ON: Send full update with showLocation: true
        sendLocationUpdate(); 
        addOrUpdatePersistentNotification("shareLocationNotif", "Your location is being shared.", "green");
    } else {
        // 🔴 OFF: Tell the server to explicitly stop sharing
        removeSharedLocation(); 
        removePersistentNotification("shareLocationNotif");
    }
    
    // Re-start the interval immediately with a fast check (500ms) to clean up stale dots
    alertIntervalId = setInterval(fetchAlerts, 500);
    
    // Set a timeout to switch back to the slower 3000ms poll rate after the cleanup check runs
    setTimeout(() => {
        clearInterval(alertIntervalId);
        alertIntervalId = setInterval(fetchAlerts, 3000);
    }, 500);

    updateUserMarker();
});

// ----------------------------------------------------------------
// Module 5: Side Menu Button Handlers (New/Updated)
// ----------------------------------------------------------------

// Helper function to show a custom informational message (since alert() is forbidden)
function showInfoModal(title, message, isEmergency = false) {
    const modal = document.createElement('div');
    modal.className = 'popup-overlay';
    modal.style.display = 'flex'; // Show modal

    modal.innerHTML = `
        <div class="popup-content" style="${isEmergency ? 'border: 3px solid #e74c3c;' : ''}">
            <h2 style="color: ${isEmergency ? '#e74c3c' : '#1abc9c'};">${title}</h2>
            <p>${message}</p>
            <button onclick="this.parentNode.parentNode.remove()">Close</button>
        </div>
    `;
    document.body.appendChild(modal);
}

// Account Button Handler (Redirects to account.html via Flask route)
document.getElementById('accountBtn').addEventListener('click', () => {
    // 🟢 FIX: Trigger Flask route directly for a full page load
    window.location.href = '/account'; 
});

// About Button Handler (Redirects to about.html via Flask route)
document.getElementById('aboutBtn').addEventListener('click', () => {
    // 🟢 FIX: Trigger Flask route directly for a full page load
    window.location.href = '/about';
});

// Police Button Handler (Emergency Contact/Info)
document.getElementById('policeBtn').addEventListener('click', () => {
    showInfoModal(
        'EMERGENCY: Contact Police', 
        'Call 100 for immediate police assistance in India. Use the Help Me button for peer assistance.',
        true
    );
});

// Hospital Button Handler (Emergency Contact/Info)
document.getElementById('hospitalBtn').addEventListener('click', () => {
    showInfoModal(
        'EMERGENCY: Find Medical Help', 
        'Call 108 for Ambulance/Medical Emergency services in India. Stay safe!',
        true
    );
});

// --- NEW LOGOUT LOGIC ADDED HERE ---
// Logout Button Handler
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    try {
        // Stop the location polling interval immediately
        if (alertIntervalId) {
            clearInterval(alertIntervalId);
        }

        // Send a POST request to the backend's /logout route
        const response = await fetch('/logout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // Check for a successful response (or just assume success if the backend is redirecting)
        if (response.ok) {
            // Redirect the user to the login page or home page
            window.location.href = '/'; 
        } else {
            // Display an error message if the logout request failed on the server
            alert('Logout failed. Please try again.');
            console.error('Server error during logout:', response.status, response.statusText);
        }
    } catch (error) {
        // Handle network errors (e.g., server is unreachable)
        alert('A network error occurred. Could not complete logout.');
        console.error('Network error during logout:', error);
    }
});
// ------------------------------------

// ----------------------------------------------------------------
// End Module 5
// ----------------------------------------------------------------

setInterval(updateHelperDistances, 3000);

document.addEventListener("DOMContentLoaded", initMap);