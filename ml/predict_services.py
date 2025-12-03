# predict_service.py 
from flask import Flask, jsonify, request #web framework
from flask_cors import CORS #allows node.js to call this python ML
import pickle #loads saved models
import json #reads metadata
import pyodbc #connects to database
import numpy as np #math operations 
from datetime import datetime, timedelta
from prediction_logger import log_prediction

#create the web server 
#enable cross origin requests (from different ports)

app = Flask(__name__) 
CORS(app)

# database connection
conn_str = (
    'DRIVER={ODBC Driver 18 for SQL Server};'
    'SERVER=YOUR_SERVER.database.windows.net;'
    'DATABASE=basketball_data;'
    'UID=YOUR_USERNAME;'
    'PWD=YOUR_PASSWORD;'
    'Encrypt=yes;'
    'TrustServerCertificate=no;'
)

#load all 6 trained models from the .pkl files

print("Loading ML models...")
with open('points_model.pkl', 'rb') as f:
    points_model = pickle.load(f) #all of this runs once at server start up, and we are loading the model into memory

with open('rebounds_model.pkl', 'rb') as f:
    rebounds_model = pickle.load(f)

with open('assists_model.pkl', 'rb') as f:
    assists_model = pickle.load(f)

with open('steals_model.pkl', 'rb') as f:
    steals_model = pickle.load(f)

with open('blocks_model.pkl', 'rb') as f:
    blocks_model = pickle.load(f)

with open('turnovers_model.pkl', 'rb') as f:
    turnovers_model = pickle.load(f)


#laod the features list from metadata.json

with open('model_metadata.json', 'r') as f:
    metadata = json.load(f)
    points_features = metadata['points_features']
    rebounds_features = metadata['rebounds_features']
    assists_features = metadata['assists_features']
    steals_features = metadata['steals_features']
    blocks_features = metadata['blocks_features']
    turnovers_features = metadata['turnovers_features']

#these saved models make it easy for users to get quick results cause they are already trained


print("✓ Models loaded successfully!")
print(f"Points features: {points_features}")

#this function fetches all the data needed to make a prediction
def get_player_features(player_name, opponent_team):
    conn = pyodbc.connect(conn_str) #connect to database
    cursor = conn.cursor() #a cursor is a tool for running sql queries 
    
    # get player aggregates
    cursor.execute("""
        SELECT TOP 1
            ISNULL(pa.AvgPoints, 0), 
            ISNULL(pa.AvgRebounds, 0), 
            ISNULL(pa.AvgAssists, 0),
            ISNULL(pa.AvgSteals, 0),     
            ISNULL(pa.AvgBlocks, 0),      
            ISNULL(pa.AvgTurnovers, 0),
            ISNULL(pa.Last5AvgPoints, 0), 
            ISNULL(pa.Last10AvgPoints, 0), 
            ISNULL(pa.GamesPlayed, 0),
            s.PlayerApiId
        FROM PlayerAggregates pa
        JOIN Stats s ON pa.PlayerApiId = s.PlayerApiId
        WHERE s.PlayerName LIKE ? 
        AND pa.Season = '2025-2026'
        AND s.Season = '2025-2026'
        ORDER BY s.GameDate DESC
    """, f'%{player_name}%')

    #fill in the ? with player name
    
    agg_row = cursor.fetchone() #gets the first result row
    if not agg_row:
        conn.close() #if not player found, close connection, return None
        return None
    
    #unpack the row into seperate variables
    season_pts, season_reb, season_ast, season_steals, season_blocks, season_turnovers, last5_pts, last10_pts, games, player_api_id = agg_row
    
    # get matchup history
    cursor.execute("""
    SELECT 
        AVG(ISNULL(pvt.AvgPoints, 0)), 
        AVG(ISNULL(pvt.AvgRebounds, 0)), 
        AVG(ISNULL(pvt.AvgAssists, 0)), 
        SUM(ISNULL(pvt.GamesPlayed, 0))
    FROM PlayerVsTeam pvt
    JOIN Teams t ON pvt.OpponentTeamId = t.Id
    WHERE pvt.PlayerApiId = ?
    AND t.TeamName LIKE ?
    AND pvt.Season IN ('2022-2023', '2023-2024','2024-2025', '2025-2026')
""", player_api_id, f'%{opponent_team}%')
    
    vs_row = cursor.fetchone()
    print(f"DEBUG: Player={player_name}, Opponent={opponent_team}")
    print(f"DEBUG: vs_row = {vs_row}")

    #if there is matchup history, use these stats
    if vs_row and vs_row[3] is not None and vs_row[3] >= 1:
        vs_pts, vs_reb, vs_ast, vs_games = vs_row
        print(f"DEBUG: Using matchup history - {vs_pts} pts in {vs_games} games")

    #if no matchup history, fall back to season averages
    else:
        vs_pts = season_pts
        vs_reb = season_reb
        vs_ast = season_ast
        vs_games = 0
        print(f"DEBUG: No matchup history, using season avg")

    #get opponent defensive stats
    cursor.execute("""
    SELECT TOP 1 
        ISNULL(AvgPointsAllowed, 117),
        ISNULL(AvgReboundsAllowed, 43)
    FROM OpponentDefensiveStats ods
    JOIN Teams t ON ods.TeamId = t.Id
    WHERE t.TeamName LIKE ?
    AND ods.Season = '2025-2026'
""", f'%{opponent_team}%')

    #get the result
    opp_row = cursor.fetchone()
    #if we found an opponent, use their actual points, if not use league average (117)
    opp_def = opp_row[0] if opp_row else 117.0
    #same with rebounds allowed
    opp_reb_allowed = opp_row[1] if opp_row and len(opp_row) > 1 else 43.0
    
    conn.close()
    
    # calculate derived features with NULL protection
    #need to make sure we give the model all the data it expects or we will get an error

    last5_pts = last5_pts if last5_pts and last5_pts > 0 else season_pts
    last10_pts = last10_pts if last10_pts and last10_pts > 0 else season_pts
    recent_form = float(last5_pts - season_pts)
    matchup_advantage = float(vs_pts - season_pts)
    defensive_difficulty = float((opp_def -117) / 10)
    is_veteran = 1 if games >= 50 else 0
    has_matchup_history = 1 if vs_games >= 2 else 0
    is_home = 1
    
    #create one dictionary with all features, then the model will pick which ones it needs
    return {
        # points features
        'SeasonAvgPoints': float(season_pts or 0),
        'Last5AvgPoints': float(last5_pts or 0),
        'Last10AvgPoints': float(last10_pts or 0),
        'GamesPlayed': int(games or 0),
        'RecentForm': recent_form,
        'IsHome': int(is_home),
        'OppDefenseRating': float(opp_def or 117),
        'VsTeamAvgPoints': float(vs_pts or 0),
        'MatchupAdvantage': matchup_advantage,
        'DefensiveDifficulty': defensive_difficulty,
        'IsVeteran': int(is_veteran),
        'HasMatchupHistory': int(has_matchup_history),
        
        # rebounds features
        'SeasonAvgRebounds': float(season_reb or 0),
        'VsTeamAvgRebounds': float(vs_reb or 0),
        'OppReboundsAllowed': float(opp_reb_allowed or 43),
        
        # assists features
        'SeasonAvgAssists': float(season_ast or 0),
        'VsTeamAvgAssists': float(vs_ast or 0),
        
        #defensive features
        'SeasonAvgSteals': float(season_steals or 0),      
        'SeasonAvgBlocks': float(season_blocks or 0),      
        'SeasonAvgTurnovers': float(season_turnovers or 0) 
    }

#calculate the confidence of the prediction
#needs prediction value, standard deviation from 200 trees, the feature dictionary, and the stat type
def calculate_confidence(prediction, std_dev, features, stat_type):
    
    # 1. model uncertainty (30 points max)
    if stat_type == 'points':
        uncertainty_score = max(0, 30 - (std_dev * 3))
    else:  
        uncertainty_score = max(0, 30 - (std_dev * 5)) #rebounds have smaller numbers, so their std_dev is naturally smaller
        #we mutliply by 5 to penalize an uncertanity more heavily
    
    # 2. consistency  (25 points max)
    recent_form_diff = abs(features['RecentForm']) #recentform = last5avgpoints - seasonavgpoints
    if recent_form_diff < 2: #player is very consistent, higher confidence
        consistency_score = 25 
    elif recent_form_diff < 4: #less consistent, somewhat confident
        consistency_score = 15
    elif recent_form_diff < 6: #inconsistent, player is hot/cold, lower confidence
        consistency_score = 8
    else:
        consistency_score = 0 #very inconsistent, no confidence boost 
    
    # 3. sample size bonus (25 points max), more games = more data = better prediction
    games_played = features['GamesPlayed']
    if games_played >= 40:
        sample_score = 25
    elif games_played >= 25:
        sample_score = 18
    elif games_played >= 15:
        sample_score = 12
    elif games_played >= 10:
        sample_score = 6
    else:
        sample_score = 0
    
    # 4. matchup history bonus (20 points max)
    if features['HasMatchupHistory']:
        matchup_score = 20 #played this opponent 2+ times before
    else:
        matchup_score = 10 #never played them or played them once
    
    # total confidence (35-85)
    total = uncertainty_score + consistency_score + sample_score + matchup_score
    return int(max(35, min(85, total)))

@app.route('/api/ml/predict/<player>/<opponent>', methods=['GET'])
def predict(player, opponent):
    #make ML prediction for player vs opponent
    
    #query the database, get season stats, matchuph history, opponent defense 
    #calculate derived features 
    #return the dictionary 
    features = get_player_features(player, opponent)
    
    #if player not found, return error 
    if not features:
        return jsonify({'error': 'Player not found or insufficient data'}), 404
    
    try:
        # prepare feature arrays for each model

        """
        1. loop through each feature 
        2. look up eaach value
        3. create the list 
        4. wrap in another list (sklearn requires 2d array)
        5. convert to numpy array
        """
        points_X = np.array([[features[f] for f in points_features]])
        rebounds_X = np.array([[features[f] for f in rebounds_features]])
        assists_X = np.array([[features[f] for f in assists_features]])
        steals_X = np.array([[features[f] for f in steals_features]])
        blocks_X = np.array([[features[f] for f in blocks_features]])
        turnovers_X = np.array([[features[f] for f in turnovers_features]])

        # make predictions
        """
        1. takes the trained model 
        2. passes in the 12 features
        3. each of the 200 trees make a prediction
        4. averages them
        5. returns array with 1 value [0]
        """
        points_pred = float(points_model.predict(points_X)[0])
        rebounds_pred = float(rebounds_model.predict(rebounds_X)[0])
        assists_pred = float(assists_model.predict(assists_X)[0])
        steals_pred = float(steals_model.predict(steals_X)[0])
        blocks_pred = float(blocks_model.predict(blocks_X)[0])
        turnovers_pred = float(turnovers_model.predict(turnovers_X)[0])

        #reality check for steals/blocks

        if features['SeasonAvgSteals'] > 0:
            steals_pred = min(steals_pred, features['SeasonAvgSteals'] * 1.8)
        else:
            steals_pred = min(steals_pred, 1.0)  # Cap at 1 if no season data
            
        if features['SeasonAvgBlocks'] > 0:
            blocks_pred = min(blocks_pred, features['SeasonAvgBlocks'] * 1.8)
        else:
            blocks_pred = min(blocks_pred, 1.0)  # Cap at 1 if no season data
        
        # Calculate std deviation from tree predictions
       
        """
        estimators = list of all 200 trees
        1. loop through each tree
        2. get each tree prediction
        3. result = 200 predictions 
        4. calculate std of those 200 trees

        low standard deviation (all trees agree) = high confidence, they all saw similar patterns in different data
        high standard deviatino (trees disagree) = low confidence, data is inconsistent
        """

        points_trees = [tree.predict(points_X)[0] for tree in points_model.estimators_]
        points_std = np.std(points_trees)

        rebounds_trees = [tree.predict(rebounds_X)[0] for tree in rebounds_model.estimators_]
        rebounds_std = np.std(rebounds_trees)
        
        assists_trees = [tree.predict(assists_X)[0] for tree in assists_model.estimators_]
        assists_std = np.std(assists_trees)

        steals_trees = [tree.predict(steals_X)[0] for tree in steals_model.estimators_]
        steals_std = np.std(steals_trees)

        blocks_trees = [tree.predict(blocks_X)[0] for tree in blocks_model.estimators_]
        blocks_std = np.std(blocks_trees)

        turnovers_trees = [tree.predict(turnovers_X)[0] for tree in turnovers_model.estimators_]
        turnovers_std = np.std(turnovers_trees)

        #call confidence function 6 times, for each stat

        steals_confidence = calculate_confidence(steals_pred, steals_std, features, 'steals')
        blocks_confidence = calculate_confidence(blocks_pred, blocks_std, features, 'blocks')
        turnovers_confidence = calculate_confidence(turnovers_pred, turnovers_std, features, 'turnovers')
        
        # Calculate confidence using improved formula
        points_confidence = calculate_confidence(points_pred, points_std, features, 'points')
        rebounds_confidence = calculate_confidence(rebounds_pred, rebounds_std, features, 'rebounds')
        assists_confidence = calculate_confidence(assists_pred, assists_std, features, 'assists')

        # calculate fantasy score
        fantasy_score = (
            points_pred + 
            (rebounds_pred * 1.2) + 
            (assists_pred * 1.5) + 
            (steals_pred * 3) + 
            (blocks_pred * 3) - 
            (turnovers_pred * 1)
        )
        
        # log prediction for accuracy tracking
        try:
            game_date = datetime.now() + timedelta(days=1)
            log_prediction(player, opponent, points_pred, rebounds_pred, assists_pred, game_date)
        except Exception as e:
            print(f"Warning: Could not log prediction: {e}")
        
        #package everything into json to send back to node.js
        return jsonify({
            'player': player,
            'opponent': opponent,
            'model': 'Random Forest ML (Advanced Features)',
            'predictions': {
                'points': {
                    'value': round(points_pred, 1),
                    'confidence': points_confidence,
                    'range': {
                        'low': round(max(0, points_pred - points_std * 1.5), 1),
                        'high': round(points_pred + points_std * 1.5, 1)
                    }
                },
                'rebounds': {
                    'value': round(rebounds_pred, 1),
                    'confidence': rebounds_confidence,
                    'range': {
                        'low': round(max(0, rebounds_pred - rebounds_std * 1.5), 1),
                        'high': round(rebounds_pred + rebounds_std * 1.5, 1)
                    }
                },
                'assists': {
                    'value': round(assists_pred, 1),
                    'confidence': assists_confidence,
                    'range': {
                        'low': round(max(0, assists_pred - assists_std * 1.5), 1),
                        'high': round(assists_pred + assists_std * 1.5, 1)
                    }
                },
                'steals': {
                    'value': round(steals_pred, 1),
                    'confidence': steals_confidence
                },
                'blocks': {
                    'value': round(blocks_pred, 1),
                    'confidence': blocks_confidence
                },
                'turnovers': {
                    'value': round(turnovers_pred, 1),
                    'confidence': turnovers_confidence
                }, 
                'fantasyScore': {
                    'value': round(fantasy_score, 1),
                    'confidence': 70  # just the average of all 6 confidences
                }
            },
            'breakdown': {
                'seasonAvgPoints': round(features['SeasonAvgPoints'], 1),
                'seasonAvgRebounds': round(features['SeasonAvgRebounds'], 1),
                'seasonAvgAssists': round(features['SeasonAvgAssists'], 1),
                'seasonAvgSteals': round(features['SeasonAvgSteals'], 1),  
                'seasonAvgBlocks': round(features['SeasonAvgBlocks'], 1),   
                'seasonAvgTurnovers': round(features['SeasonAvgTurnovers'], 1), 
                'last5AvgPoints': round(features['Last5AvgPoints'], 1),
                'vsTeamPoints': round(features['VsTeamAvgPoints'], 1) if features['HasMatchupHistory'] else None,
                'vsTeamRebounds': round(features['VsTeamAvgRebounds'], 1) if features['HasMatchupHistory'] else None,
                'vsTeamAssists': round(features['VsTeamAvgAssists'], 1) if features['HasMatchupHistory'] else None,
                'opponentDefense': round(features['OppDefenseRating'], 1),
                'opponentReboundsAllowed': round(features['OppReboundsAllowed'], 1)
            } #this is the data section that my front end displays
        })
    
    #catch any endpoint error
    except Exception as e:
        print(f"Prediction error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Prediction failed: {str(e)}'}), 500


#this retrains the model without having to restart the server
@app.route('/api/ml/retrain', methods=['POST'])
def retrain():

    import subprocess #python library that lets you run shell commands form python code
    
    try:
        result = subprocess.run(['python3', 'train_model.py'], #runs the command to retrain
                              capture_output=True, text=True, timeout=300)
        
        if result.returncode == 0: #0 = success, non-zero = error
            # reload models
            #this global keyword expresses that we want to modify varaiables that were defined at the top of the file, not create new ones
            global points_model, rebounds_model, assists_model, points_features, rebounds_features, assists_features
            
            with open('points_model.pkl', 'rb') as f:
                points_model = pickle.load(f) #updates the actual model, and re loads it
            with open('rebounds_model.pkl', 'rb') as f:
                rebounds_model = pickle.load(f)
            with open('assists_model.pkl', 'rb') as f:
                assists_model = pickle.load(f)
            
            with open('model_metadata.json', 'r') as f:
                metadata = json.load(f)
                points_features = metadata['points_features']
                rebounds_features = metadata['rebounds_features']
                assists_features = metadata['assists_features']
            
            return jsonify({'status': 'success', 'message': 'Models retrained and reloaded'})
        else:
            return jsonify({'status': 'error', 'message': result.stderr}), 500
    
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/ml/health', methods=['GET'])
def health():
    #health check
    return jsonify({
        'status': 'healthy', 
        'model': 'Random Forest ML',
        'features': {
            'points': len(points_features),
            'rebounds': len(rebounds_features),
            'assists': len(assists_features)
        }
    })

if __name__ == '__main__':
    print("\nNBA ML Prediction Service")
    print("Running on http://localhost:5001")
    app.run(host='0.0.0.0', port=5001, debug=True)