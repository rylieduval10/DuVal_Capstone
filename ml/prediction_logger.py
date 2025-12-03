import pyodbc
from datetime import datetime
import json

# database connection string with credentials and settings
conn_str = (
    'DRIVER={ODBC Driver 18 for SQL Server};'
    'SERVER=YOUR_SERVER.database.windows.net;'
    'DATABASE=basketball_data;'
    'UID=YOUR_USERNAME;'
    'PWD=YOUR_PASSWORD;'
    'Encrypt=yes;'
    'TrustServerCertificate=no;'
)

# create table to store ml predictions if it doesn't exist
def create_predictions_table():
    """Create table to store predictions"""
    # connect to database
    conn = pyodbc.connect(conn_str)
    cursor = conn.cursor()
    
    # sql to create table if not exists
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='MLPredictions' AND xtype='U')
        CREATE TABLE MLPredictions (
            Id INT IDENTITY(1,1) PRIMARY KEY,
            PlayerName NVARCHAR(100) NOT NULL,
            OpponentTeam NVARCHAR(100) NOT NULL,
            GameDate DATETIME NULL,
            PredictedPoints FLOAT NOT NULL,
            PredictedRebounds FLOAT NOT NULL,
            PredictedAssists FLOAT NOT NULL,
            ActualPoints INT NULL,
            ActualRebounds INT NULL,
            ActualAssists INT NULL,
            PointsError FLOAT NULL,
            ReboundsError FLOAT NULL,
            AssistsError FLOAT NULL,
            CreatedDate DATETIME DEFAULT GETDATE(),
            GameCompleted BIT DEFAULT 0
        )
    """)
    
    # save changes and close connection
    conn.commit()
    conn.close()
    print("✓ MLPredictions table created")

# save a new prediction to the database
def log_prediction(player_name, opponent_team, predicted_points, 
                  predicted_rebounds, predicted_assists, game_date=None):
    """Log a prediction to the database"""
    # connect to database
    conn = pyodbc.connect(conn_str)
    cursor = conn.cursor()
    
    # insert prediction into table
    cursor.execute("""
        INSERT INTO MLPredictions 
        (PlayerName, OpponentTeam, GameDate, PredictedPoints, 
         PredictedRebounds, PredictedAssists)
        VALUES (?, ?, ?, ?, ?, ?)
    """, player_name, opponent_team, game_date, 
         predicted_points, predicted_rebounds, predicted_assists)
    
    # save changes and get the id of the inserted prediction
    conn.commit()
    prediction_id = cursor.execute("SELECT @@IDENTITY").fetchone()[0]
    conn.close()
    
    return prediction_id

# update predictions with actual game results after games complete
def update_with_actual_results():
    """After games complete, update predictions with actual results"""
    # connect to database
    conn = pyodbc.connect(conn_str)
    cursor = conn.cursor()
    
    # find predictions that don't have actual results yet
    cursor.execute("""
        SELECT 
            p.Id,
            p.PlayerName,
            p.OpponentTeam,
            p.PredictedPoints,
            p.PredictedRebounds,
            p.PredictedAssists
        FROM MLPredictions p
        WHERE p.GameCompleted = 0
        AND p.GameDate < GETDATE()
    """)
    
    # get all pending predictions
    pending_predictions = cursor.fetchall()
    updated_count = 0
    
    # loop through each pending prediction
    for pred in pending_predictions:
        # unpack the prediction data
        pred_id, player, opponent, pred_pts, pred_reb, pred_ast = pred
        
        # find the actual game stats from the stats table
        cursor.execute("""
            SELECT TOP 1 s.Points, s.TotalRebounds, s.Assists
            FROM Stats s
            JOIN Games g ON s.GameId = g.Id
            WHERE s.PlayerName LIKE ?
            AND (g.HomeTeam LIKE ? OR g.AwayTeam LIKE ?)
            AND s.GameDate >= DATEADD(day, -7, GETDATE())
            ORDER BY s.GameDate DESC
        """, f'%{player}%', f'%{opponent}%', f'%{opponent}%')
        
        # get the actual stats
        actual = cursor.fetchone()
        
        # if actual stats found, update the prediction record
        if actual:
            # unpack actual stats
            actual_pts, actual_reb, actual_ast = actual
            
            # calculate how far off the predictions were
            pts_error = abs(pred_pts - actual_pts)
            reb_error = abs(pred_reb - actual_reb)
            ast_error = abs(pred_ast - actual_ast)
            
            # update the prediction record with actual results
            cursor.execute("""
                UPDATE MLPredictions
                SET ActualPoints = ?,
                    ActualRebounds = ?,
                    ActualAssists = ?,
                    PointsError = ?,
                    ReboundsError = ?,
                    AssistsError = ?,
                    GameCompleted = 1
                WHERE Id = ?
            """, actual_pts, actual_reb, actual_ast, 
                 pts_error, reb_error, ast_error, pred_id)
            
            # increment counter and print results
            updated_count += 1
            print(f"✓ Updated prediction for {player} vs {opponent}")
            print(f"  Predicted: {pred_pts:.1f} pts, {pred_reb:.1f} reb, {pred_ast:.1f} ast")
            print(f"  Actual: {actual_pts} pts, {actual_reb} reb, {actual_ast} ast")
            print(f"  Error: {pts_error:.1f} pts, {reb_error:.1f} reb, {ast_error:.1f} ast\n")
    
    # save all changes and close connection
    conn.commit()
    conn.close()
    
    return updated_count

# calculate overall model accuracy from completed predictions
def get_model_accuracy():
    """Calculate overall model accuracy"""
    # connect to database
    conn = pyodbc.connect(conn_str)
    cursor = conn.cursor()
    
    # query to get average errors across all completed predictions
    cursor.execute("""
        SELECT 
            COUNT(*) as TotalPredictions,
            AVG(PointsError) as AvgPointsError,
            AVG(ReboundsError) as AvgReboundsError,
            AVG(AssistsError) as AvgAssistsError
        FROM MLPredictions
        WHERE GameCompleted = 1
    """)
    
    # get results
    result = cursor.fetchone()
    conn.close()
    
    # if there are completed predictions, return accuracy stats
    if result[0] > 0:
        return {
            'total_predictions': result[0],
            'avg_points_error': round(result[1], 2),
            'avg_rebounds_error': round(result[2], 2),
            'avg_assists_error': round(result[3], 2)
        }
    else:
        return None

# check if model should be retrained based on new data
def should_retrain():
    """Determine if model should be retrained"""
    # connect to database
    conn = pyodbc.connect(conn_str)
    cursor = conn.cursor()
    
    # check how many new completed games in the last 7 days
    cursor.execute("""
        SELECT COUNT(*)
        FROM MLPredictions
        WHERE GameCompleted = 1
        AND CreatedDate > DATEADD(day, -7, GETDATE())
    """)
    
    # get count of recent completed predictions
    recent_completed = cursor.fetchone()[0]
    conn.close()
    
    # retrain if we have 20 or more new results
    return recent_completed >= 20

# main execution when script is run directly
if __name__ == "__main__":
    print("Setting up prediction logging system...\n")
    
    # create table if it doesn't exist
    create_predictions_table()
    
    # update any pending predictions with actual results
    print("\nChecking for completed games...")
    updated = update_with_actual_results()
    print(f"Updated {updated} predictions with actual results")
    
    # show model accuracy stats
    accuracy = get_model_accuracy()
    if accuracy:
        print("\nMODEL ACCURACY")
        print(f"Total predictions validated: {accuracy['total_predictions']}")
        print(f"Average error:")
        print(f"  Points: {accuracy['avg_points_error']}")
        print(f"  Rebounds: {accuracy['avg_rebounds_error']}")
        print(f"  Assists: {accuracy['avg_assists_error']}")
    
    # check if model needs retraining
    if should_retrain():
        print("\nModel should be retrained (20+ new results available)")
        print("Run: python3 train_model.py")
    else:
        print("\n✓ Model is up to date")