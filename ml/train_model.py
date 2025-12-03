# train_model.py - train ml model for nba predictions
import pandas as pd  #handles data tables (data frames)
import numpy as np #math operations
from sklearn.ensemble import RandomForestRegressor #the random forest ml algorithm
from sklearn.model_selection import train_test_split #splits data into training and testing sets
from sklearn.metrics import mean_absolute_error, r2_score #measurement of how good the model is
import pyodbc #python library for connecting to database
import pickle #pythons way of saving/loading objects to files
import json #library for working with JSON data

# azure database connection string
conn_str = (
    'DRIVER={ODBC Driver 18 for SQL Server};'
    'SERVER=YOUR_SERVER.database.windows.net;'
    'DATABASE=basketball_data;'
    'UID=YOUR_USERNAME;'
    'PWD=YOUR_PASSWORD;'
    'Encrypt=yes;'
    'TrustServerCertificate=no;'
)

def fetch_training_data():
    #fetch historical game data 
    """
    what this does: 
    connects to azure database, runs sql query to join multiple tables, gets actual stats (what happened) along with features (information to predict with) and returns a pandas dataframe 

    features pulled:
    actual stats, season averages, recent form (last 5 and 10 game averages), opponent defense, home/away, matchup history
    """
    conn = pyodbc.connect(conn_str)

    #sql query that joins 4 tables (stats, playeraggregates, games, opponentdefensivestats)
    
    query = """
    SELECT 
        s.Points as ActualPoints,
        s.TotalRebounds as ActualRebounds,
        s.Assists as ActualAssists,
        s.Steals as ActualSteals,
        s.Blocks as ActualBlocks,
        s.Turnovers as ActualTurnovers,
        pa.AvgPoints as SeasonAvgPoints,
        pa.AvgRebounds as SeasonAvgRebounds,
        pa.AvgAssists as SeasonAvgAssists,
        pa.AvgSteals as SeasonAvgSteals,       
        pa.AvgBlocks as SeasonAvgBlocks,        
        pa.AvgTurnovers as SeasonAvgTurnovers,   
        pa.Last5AvgPoints,
        pa.Last10AvgPoints,
        pa.GamesPlayed,
        s.TeamName,
        s.PlayerApiId,
        CASE 
            WHEN s.TeamName = g.HomeTeam THEN 1
            ELSE 0
        END as IsHome,
        CASE 
            WHEN s.TeamName = g.HomeTeam THEN g.AwayTeam
            ELSE g.HomeTeam
        END as OpponentTeam,
        -- Opponent defensive rating
        ISNULL(ods.AvgPointsAllowed, 110) as OppDefenseRating,
        ISNULL(ods.AvgReboundsAllowed, 43) as OppReboundsAllowed
    FROM Stats s
    JOIN PlayerAggregates pa ON s.PlayerApiId = pa.PlayerApiId 
        AND s.Season = pa.Season
    LEFT JOIN Games g ON s.GameId = g.Id
    LEFT JOIN OpponentDefensiveStats ods ON ods.Season = s.Season
        AND ods.TeamId = (
            SELECT TOP 1 Id FROM Teams WHERE TeamName = 
            CASE WHEN s.TeamName = g.HomeTeam THEN g.AwayTeam ELSE g.HomeTeam END
        )
    WHERE s.Season IN ('2022-2023', '2023-2024', '2024-2025', '2025-2026')
        AND s.Points IS NOT NULL
        AND pa.AvgPoints IS NOT NULL
        AND pa.GamesPlayed >= 5
    """
    
    df = pd.read_sql(query, conn)
    
    # fetch player vs team matchup history
    #this tells us how a player histroically performs against a specific team
    print("Fetching player vs team matchup history...")
    
    # get all historical matchup data
    matchup_query = """
    SELECT 
        pvt.PlayerApiId,
        t.TeamName as OpponentTeam,
        pvt.AvgPoints as VsTeamAvgPoints,
        pvt.AvgRebounds as VsTeamAvgRebounds,
        pvt.AvgAssists as VsTeamAvgAssists,
        pvt.GamesPlayed as VsTeamGames
    FROM PlayerVsTeam pvt
    JOIN Teams t ON pvt.OpponentTeamId = t.Id
    WHERE pvt.Season IN ('2022-2023', '2023-2024', '2024-2025', '2025-2026')
    """
    
    matchup_df = pd.read_sql(matchup_query, conn)
    conn.close()
    
    # merge the matchup history into main dataframe
    #matches players on playerAPIId and opponent team
    
    df = df.merge(
        matchup_df,
        on=['PlayerApiId', 'OpponentTeam'],
        how='left'
    )

    #how = 'left' keeps all rows from main data
    
    # fill missing matchup data with season averages
    #if there is no matchup data, just use season avg as fall back

    df['VsTeamAvgPoints'] = df['VsTeamAvgPoints'].fillna(df['SeasonAvgPoints'])
    df['VsTeamAvgRebounds'] = df['VsTeamAvgRebounds'].fillna(df['SeasonAvgRebounds'])
    df['VsTeamAvgAssists'] = df['VsTeamAvgAssists'].fillna(df['SeasonAvgAssists'])
    df['VsTeamGames'] = df['VsTeamGames'].fillna(0)
    
    return df

def prepare_features(df):

    # create additional features

    #recent form, is the player hot or cold in this current moment 
    df['RecentForm'] = df['Last5AvgPoints'] - df['SeasonAvgPoints']
    df['Last5AvgPoints'] = df['Last5AvgPoints'].fillna(df['SeasonAvgPoints'])
    df['Last10AvgPoints'] = df['Last10AvgPoints'].fillna(df['SeasonAvgPoints'])

    df['SeasonAvgSteals'] = df['SeasonAvgSteals'].fillna(0)
    df['SeasonAvgBlocks'] = df['SeasonAvgBlocks'].fillna(0)
    df['SeasonAvgTurnovers'] = df['SeasonAvgTurnovers'].fillna(0)
    
    # matchup advantage
    df['MatchupAdvantage'] = df['VsTeamAvgPoints'] - df['SeasonAvgPoints']
    
    # defensive difficulty (higher = easier to score)
    df['DefensiveDifficulty'] = (df['OppDefenseRating'] - 110) / 10
    
    # experience factor
    df['IsVeteran'] = (df['GamesPlayed'] >= 50).astype(int)
    
    # has matchup history
    df['HasMatchupHistory'] = (df['VsTeamGames'] >= 2).astype(int)
    
    return df

def train_points_model(df):
    #train Random Forest model for points prediction with advanced features

    #list of features (the clues)
    features = [
        'SeasonAvgPoints', 'Last5AvgPoints', 'Last10AvgPoints',
        'GamesPlayed', 'RecentForm', 'IsHome',
        'OppDefenseRating', 'VsTeamAvgPoints', 'MatchupAdvantage',
        'DefensiveDifficulty', 'IsVeteran', 'HasMatchupHistory'
    ]
    
    # x = features, which are the clues (seasonavgpoints, last5avgpoints, etc)
    # y = the target, the answer (what we are trying to predict)


    X = df[features]
    y = df['ActualPoints']
    
    # Split data
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    #X_train, y_train = 80% of data for learning
    #x_test, y_test = 20% of data for testing
    #holding back 20% of data avoid overfittinig, it predicts the other 20% that it has not seen before. if it does good, then it is learning patterns, if not, then we are memorizing 
    
    model = RandomForestRegressor(
        n_estimators=200,  # the number of trees
        max_depth=15,      # how deep the trees go
        min_samples_split=10, #need at least 10 examples to split a node
        min_samples_leaf=4, #each leaf must have at least 4 examples
        max_features='sqrt',
        random_state=42, #randomness
        n_jobs=-1          
    )
    
    #each tree is looking at a random subset of the training data
    #asking yes or no questions about the features
    #building a decision path
    #all trees find a prediction based on different questions from different data, and then average them for the final prediction

    model.fit(X_train, y_train)
    
    # mae = mean absolute error (ex. 3.2 = on average, the projection is off by 3.2 points)
    y_pred = model.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)
    
    print(f"Points Model - MAE: {mae:.2f}, R²: {r2:.3f}")
    
    # Feature importance
    importance = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print("\nFeature Importance (Points):")
    print(importance)
    
    return model, features

def train_rebounds_model(df):
    #train model for rebounds prediction with advanced features
    features = [
        'SeasonAvgRebounds', 'GamesPlayed', 'IsHome',
        'OppDefenseRating', 'VsTeamAvgRebounds', 'IsVeteran',
        'OppReboundsAllowed'
    ]
    
    X = df[features]
    y = df['ActualRebounds']
    
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    
    model = RandomForestRegressor(
        n_estimators=150,
        max_depth=12,
        min_samples_split=10,
        random_state=42,
        n_jobs=-1
    )
    
    model.fit(X_train, y_train)
    
    y_pred = model.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)
    
    print(f"\nRebounds Model - MAE: {mae:.2f}, R²: {r2:.3f}")
    
    # feature importance
    importance = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print("\nFeature Importance (Rebounds):")
    print(importance)
    
    return model, features

def train_assists_model(df):
    #Train model for assists prediction with advanced features
    features = [
        'SeasonAvgAssists', 'GamesPlayed', 'IsHome',
        'OppDefenseRating', 'VsTeamAvgAssists', 'IsVeteran'
    ]
    
    X = df[features]
    y = df['ActualAssists']
    
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    
    model = RandomForestRegressor(
        n_estimators=150,
        max_depth=12,
        min_samples_split=10,
        random_state=42,
        n_jobs=-1
    )
    
    model.fit(X_train, y_train)
    
    y_pred = model.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)
    
    print(f"Assists Model - MAE: {mae:.2f}, R²: {r2:.3f}")
    
    # feature importance
    importance = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print("\nFeature Importance (Assists):")
    print(importance)
    
    return model, features

def train_steals_model(df):
    #Train model for steals prediction
    # Filter out rows where steals data is missing
    df_filtered = df[df['ActualSteals'].notna() & (df['ActualSteals'] > 0)]
    
    features = [
        'SeasonAvgSteals', 'SeasonAvgPoints', 'GamesPlayed', 'IsHome',
        'OppDefenseRating', 'IsVeteran'
    ]
    
    X = df_filtered[features]
    y = df_filtered['ActualSteals']
    
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    
    model = RandomForestRegressor(
        n_estimators=150,
        max_depth=10,
        min_samples_split=10,
        random_state=42,
        n_jobs=-1
    )
    
    model.fit(X_train, y_train)
    
    y_pred = model.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)
    
    print(f"Steals Model - MAE: {mae:.2f}, R²: {r2:.3f}")
    
    importance = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print("\nFeature Importance (Steals):")
    print(importance)
    
    return model, features

def train_blocks_model(df):
    """Train model for blocks prediction"""
    df_filtered = df[df['ActualBlocks'].notna() & (df['ActualBlocks'] > 0)]
    
    features = [
        'SeasonAvgBlocks', 'SeasonAvgRebounds', 'GamesPlayed', 'IsHome',
        'OppDefenseRating', 'IsVeteran'
    ]
    
    X = df_filtered[features]
    y = df_filtered['ActualBlocks']
    
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    
    model = RandomForestRegressor(
        n_estimators=150,
        max_depth=10,
        min_samples_split=10,
        random_state=42,
        n_jobs=-1
    )
    
    model.fit(X_train, y_train)
    
    y_pred = model.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)
    
    print(f"Blocks Model - MAE: {mae:.2f}, R²: {r2:.3f}")
    
    importance = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print("\nFeature Importance (Blocks):")
    print(importance)
    
    return model, features

def train_turnovers_model(df):
    """Train model for turnovers prediction"""
    df_filtered = df[df['ActualTurnovers'].notna() & (df['ActualTurnovers'] > 0)]
    
    features = [
        'SeasonAvgTurnovers','SeasonAvgPoints', 'SeasonAvgAssists', 'GamesPlayed',
        'IsHome', 'OppDefenseRating', 'IsVeteran'
    ]
    
    X = df_filtered[features]
    y = df_filtered['ActualTurnovers']
    
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )
    
    model = RandomForestRegressor(
        n_estimators=150,
        max_depth=10,
        min_samples_split=10,
        random_state=42,
        n_jobs=-1
    )
    
    model.fit(X_train, y_train)
    
    y_pred = model.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)
    
    print(f"Turnovers Model - MAE: {mae:.2f}, R²: {r2:.3f}")
    
    importance = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)
    
    print("\nFeature Importance (Turnovers):")
    print(importance)
    
    return model, features

def save_models(points_model, rebounds_model, assists_model, steals_model, blocks_model, turnovers_model,
                points_features, rebounds_features, assists_features, steals_features, blocks_features, turnovers_features):
    #Save trained models and feature lists
    
    with open('points_model.pkl', 'wb') as f:
        pickle.dump(points_model, f)
    
    with open('rebounds_model.pkl', 'wb') as f:
        pickle.dump(rebounds_model, f)
    
    with open('assists_model.pkl', 'wb') as f:
        pickle.dump(assists_model, f)
    
    with open('steals_model.pkl', 'wb') as f:
        pickle.dump(steals_model, f)
    
    with open('blocks_model.pkl', 'wb') as f:
        pickle.dump(blocks_model, f)
    
    with open('turnovers_model.pkl', 'wb') as f:
        pickle.dump(turnovers_model, f)
    
    #this informs the predict_serivices.py to know which model needs what features and in what order
    metadata = {
        'points_features': points_features,
        'rebounds_features': rebounds_features,
        'assists_features': assists_features,
        'steals_features': steals_features,
        'blocks_features': blocks_features,
        'turnovers_features': turnovers_features
    }
    
    with open('model_metadata.json', 'w') as f:
        json.dump(metadata, f)
    
    print("\n✓ Models saved successfully!")

def main():
    print("Fetching training data...")
    df = fetch_training_data()
    print(f"Loaded {len(df)} games")
    
    print("\nPreparing features...")
    df = prepare_features(df)
    
    print(f"\nTraining on {len(df)} game records...")
    
    print("\nTraining Points model...")
    points_model, points_features = train_points_model(df)
    
    print("\nTraining Rebounds model...")
    rebounds_model, rebounds_features = train_rebounds_model(df)
    
    print("\nTraining Assists model...")
    assists_model, assists_features = train_assists_model(df)
    
    print("\nTraining Steals model...")
    steals_model, steals_features = train_steals_model(df)
    
    print("\nTraining Blocks model...")
    blocks_model, blocks_features = train_blocks_model(df)
    
    print("\nTraining Turnovers model...")
    turnovers_model, turnovers_features = train_turnovers_model(df)
    
    print("\nSaving models...")
    save_models(
        points_model, rebounds_model, assists_model, steals_model, blocks_model, turnovers_model,
        points_features, rebounds_features, assists_features, steals_features, blocks_features, turnovers_features
    )
    
    print("\n✓ Training complete!")


if __name__ == "__main__":
    main()