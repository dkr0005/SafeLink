from flask import Flask, render_template, request, redirect, url_for, session, jsonify
import math

app = Flask(__name__)
# IMPORTANT: Use a complex, secret key in a real application
app.secret_key = "your_secret_key"

# ------------------------------
# In-memory user and location storage
# ------------------------------
users = {}       # {username: {aadhar, password}}
locations = {}   # {username: {"lat": float, "lng": float, "helping": bool, "share_location": bool}}

# Tracks active helper responses
# {needy_username: {helper_username: {"lat": float, "lng": float, "distance": str}}}
active_helper_responses = {}

# ------------------------------
# Utility: Calculate distance between two lat/lng points in km
# ------------------------------
def calculate_distance(lat1, lng1, lat2, lng2):
    R = 6371  # Radius of Earth in km
    lat1_rad = math.radians(lat1)
    lng1_rad = math.radians(lng1)
    lat2_rad = math.radians(lat2)
    lng2_rad = math.radians(lng2)

    dlat = lat2_rad - lat1_rad
    dlng = lng2_rad - lng1_rad

    a = math.sin(dlat / 2) ** 2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlng / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return R * c

# ------------------------------
# Routes
# ------------------------------
@app.route('/')
def home():
    return redirect(url_for('login'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        aadhar = request.form.get('aadhar')
        password = request.form.get('password')

        user = users.get(username)
        if user and user['aadhar'] == aadhar and user['password'] == password:
            session['username'] = username
            session['aadhar'] = aadhar
            return redirect(url_for('safelink'))
        else:
            error = "Invalid credentials"
            return render_template('login.html', error=error)
    return render_template('login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username')
        aadhar = request.form.get('aadhar')
        password = request.form.get('password')

        if username in users:
            error = "Username already exists"
            return render_template('register.html', error=error)
        else:
            users[username] = {"aadhar": aadhar, "password": password}
            success = "Registration successful. Please login."
            return render_template('register.html', success=success)
    return render_template('register.html')


@app.route('/safelink')
def safelink():
    if 'username' not in session:
        return redirect(url_for('login'))

    username = session['username']
    user_aadhar = users.get(username, {}).get('aadhar', 'Not available')
    return render_template('index.html', username=username, userAadhar=user_aadhar)


@app.route('/account')
def account():
    if 'username' not in session:
        return redirect(url_for('login'))

    username = session['username']
    user_aadhar = users.get(username, {}).get('aadhar', 'Not available')
    return render_template('account.html', username=username, userAadhar=user_aadhar)


@app.route('/about')
def about():
    return render_template('about.html')


@app.route('/logout', methods=['GET', 'POST'])
def logout():
    username = session.pop('username', None)
    session.pop('aadhar', None)

    if username and username in locations:
        locations.pop(username)
        # Remove helper tracking if this user was helping someone
        for needy in list(active_helper_responses):
            if username in active_helper_responses[needy]:
                del active_helper_responses[needy][username]
                if not active_helper_responses[needy]:
                    del active_helper_responses[needy]

    return redirect(url_for('login'))

# ------------------------------
# Location Endpoints
# ------------------------------
@app.route('/update_location', methods=['POST'])
def update_location():
    data = request.get_json()
    username = data.get('username')
    lat = data.get('lat')
    lng = data.get('lng')
    show_location = data.get('showLocation', False)  # Read the boolean from client

    if username:
        locations[username] = locations.get(username, {})
        locations[username]["lat"] = lat
        locations[username]["lng"] = lng
        locations[username]["share_location"] = show_location
        locations[username]["helping"] = locations[username].get("helping", False)

    return jsonify({"status": "success"})


@app.route('/remove_location', methods=['POST'])
def remove_location():
    data = request.get_json()
    username = data.get('username')

    if username and username in locations:
        locations[username]["share_location"] = False
        return jsonify({"status": "location sharing disabled"})

    return jsonify({"status": "user not found or already disabled"})


# ------------------------------
# Help Me / Alert Endpoints
# ------------------------------
@app.route('/send_alert', methods=['POST'])
def send_alert():
    data = request.get_json()
    username = data.get('username')
    helping = data.get('helping')
    lat = data.get('lat')
    lng = data.get('lng')

    if username:
        locations[username] = locations.get(username, {})
        locations[username]["lat"] = lat
        locations[username]["lng"] = lng
        locations[username]["helping"] = helping
        locations[username]["share_location"] = True  # Share location when calling for help

        if not helping and username in active_helper_responses:
            del active_helper_responses[username]

    return jsonify({"status": "success"})


@app.route('/get_alerts', methods=['GET'])
def get_alerts():
    current_username = session.get('username')
    response = []

    for username, info in locations.items():
        if info.get("share_location") or info.get("helping"):
            alert_info = {
                "username": username,
                "lat": info["lat"],
                "lng": info["lng"],
                "helping": info.get("helping", False),
                "showLocation": info.get("share_location", False)
            }

            # Attach active helper list only if current client is needy
            if username == current_username and info.get("helping") and current_username in active_helper_responses:
                alert_info["activeHelpers"] = [
                    {"helper": helper_name, "distance": helper_info.get("distance", "N/A")}
                    for helper_name, helper_info in active_helper_responses[current_username].items()
                ]

            response.append(alert_info)

    return jsonify(response)

# ------------------------------
# Helper Response Endpoints
# ------------------------------
@app.route('/send_response', methods=['POST'])
def send_response():
    data = request.get_json()
    helper = data.get('helper')
    needy = data.get('needy')
    lat = data.get('lat')
    lng = data.get('lng')

    needy_lat = locations.get(needy, {}).get('lat', 0)
    needy_lng = locations.get(needy, {}).get('lng', 0)
    distance = f"{calculate_distance(lat, lng, needy_lat, needy_lng):.2f}"

    if needy not in active_helper_responses:
        active_helper_responses[needy] = {}

    active_helper_responses[needy][helper] = {
        "lat": lat,
        "lng": lng,
        "distance": distance
    }

    print(f"Helper {helper} is now tracking {needy} at {distance} km")
    return jsonify({"status": "helper response recorded"})


@app.route('/notify_needy', methods=['POST'])
def notify_needy():
    data = request.get_json()
    needy = data.get("needy")
    helper = data.get("helper")
    distance = data.get("distance")

    if needy in active_helper_responses and helper in active_helper_responses[needy]:
        active_helper_responses[needy][helper]["distance"] = distance

    print(f"Notify needy {needy}: Helper {helper} updated distance to {distance} km")
    return jsonify({"status": "needy notified"})


@app.route('/notify_safe', methods=['POST'])
def notify_safe():
    data = request.get_json()
    username = data.get("username")

    if username in active_helper_responses:
        del active_helper_responses[username]

    print(f"User {username} no longer needs help")
    return jsonify({"status": "helpers notified"})


# ------------------------------
# Run Server
# ------------------------------
if __name__ == '__main__':
    app.run(debug=True)
# if __name__ == "__main__":
#     app.run(host="0.0.0.0", port=5000, debug=True)
