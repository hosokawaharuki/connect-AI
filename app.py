import os
import subprocess
import threading
import sqlalchemy
from flask import Flask, render_template, request, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from flask_socketio import SocketIO, emit, join_room
import openai
from werkzeug.security import generate_password_hash, check_password_hash

os.environ['TAVILY_API_KEY'] = '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'

try:
    from tavily import TavilyClient
    tavily_available = True
except ImportError:
    tavily_available = False

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'conect_ai_super_secret_key')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///app.db'
db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', max_http_buffer_size=50 * 1024 * 1024)

login_manager = LoginManager(app)
login_manager.login_view = 'login'

def start_ollama_automatically():
    if os.environ.get('RENDER'):
        return
    try:
        subprocess.Popen(
            ["ollama", "run", "qwen2.5:1.5b"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        )
    except Exception as e:
        pass

openai_api_key = os.environ.get('OPENAI_API_KEY')

if openai_api_key:
    client = openai.OpenAI(api_key=openai_api_key)
    AI_MODEL = "gpt-4o-mini"
else:
    client = openai.OpenAI(
        base_url="http://localhost:11434/v1",
        api_key="ollama"
    )
    AI_MODEL = "qwen2.5:1.5b"

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False)
    password = db.Column(db.String(150), nullable=False)

class ChatMessage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))
    message = db.Column(db.Text, nullable=False)
    read_count = db.Column(db.Integer, default=1)
    is_deleted = db.Column(db.Boolean, default=False)
    timestamp = db.Column(db.DateTime, default=db.func.current_timestamp())

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

@app.route('/')
@login_required
def index():
    return render_template('index.html', username=current_user.username)

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        if User.query.filter_by(username=username).first():
            flash('そのユーザー名は既に使用されています。')
            return redirect(url_for('register'))
        hashed_pw = generate_password_hash(password, method='pbkdf2:sha256')
        new_user = User(username=username, password=hashed_pw)
        db.session.add(new_user)
        db.session.commit()
        return redirect(url_for('login'))
    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        user = User.query.filter_by(username=username).first()
        if user and check_password_hash(user.password, password):
            login_user(user)
            return redirect(url_for('index'))
        flash('ユーザー名またはパスワードが間違っています。')
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

@socketio.on('join')
def on_join(data):
    room = data.get('room', 'main_room')
    join_room(room)
    emit('user_joined', {'username': current_user.username}, to=room)

@socketio.on('draw')
def on_draw(data):
    room = data.get('room', 'main_room')
    emit('draw_sync', data, to=room, include_self=False)

@socketio.on('webrtc_offer')
def on_offer(data):
    room = data.get('room', 'main_room')
    emit('webrtc_offer', data, to=room, include_self=False)

@socketio.on('webrtc_answer')
def on_answer(data):
    room = data.get('room', 'main_room')
    emit('webrtc_answer', data, to=room, include_self=False)

@socketio.on('webrtc_ice_candidate')
def on_ice_candidate(data):
    room = data.get('room', 'main_room')
    emit('webrtc_ice_candidate', data, to=room, include_self=False)

@socketio.on('send_message')
def on_message(data):
    msg = data.get('message', '')
    file_data = data.get('file', None)
    file_type = data.get('file_type', '')
    file_name = data.get('file_name', 'file')
    room = data.get('room', 'main_room')
    
    display_msg = msg if msg else f"[ファイル送信: {file_name}]"
    
    with app.app_context():
        new_msg = ChatMessage(user_id=current_user.id, message=display_msg, read_count=1, is_deleted=False)
        db.session.add(new_msg)
        db.session.commit()
        msg_id = new_msg.id
        username = current_user.username
    
    socketio.emit('receive_message', {
        'id': msg_id,
        'user': username, 
        'message': msg, 
        'file': file_data, 
        'file_type': file_type,
        'file_name': file_name,
        'read_count': 1
    }, room=room)

@socketio.on('delete_message')
def on_delete_message(data):
    msg_id = data.get('id')
    room = data.get('room', 'main_room')
    with app.app_context():
        msg = ChatMessage.query.get(msg_id)
        if msg:
            msg.is_deleted = True
            db.session.commit()
    socketio.emit('message_deleted', {'id': msg_id}, room=room)

def async_ai_task(prompt, app_instance, room):
    with app_instance.app_context():
        try:
            search_context = ""
            if tavily_available:
                try:
                    tavily = TavilyClient(api_key=os.environ.get('TAVILY_API_KEY'))
                    search_result = tavily.search(query=prompt, max_results=2)
                    results = search_result.get('results', [])
                    snippets = [r.get('content', '') for r in results if r.get('content')]
                    if snippets:
                        search_context = "\n".join(snippets[:2])
                except Exception:
                    pass

            full_prompt = f"質問: {prompt}\n\n参考情報:\n{search_context if search_context else 'なし'}\n\n指示: 上記の質問に対し、関係のない情報を混ぜず、簡潔かつ正確に日本語で答えてください。"

            response = client.chat.completions.create(
                model=AI_MODEL, 
                messages=[
                    {"role": "system", "content": "あなたは正確で簡潔なAIアシスタントです。質問に対して嘘をつかず、関係のない話題に脱線しないで答えてください。"},
                    {"role": "user", "content": full_prompt}
                ],
                max_tokens=150,
                temperature=0.1,
                timeout=25
            )
            answer_text = response.choices[0].message.content.strip()
        except Exception as e:
            answer_text = f"⚠️ AI応答エラー (APIキーや環境をご確認ください): {str(e)}"
        
        with app_instance.app_context():
            new_msg = ChatMessage(user_id=1, message=answer_text, read_count=1, is_deleted=False)
            db.session.add(new_msg)
            db.session.commit()
            msg_id = new_msg.id

        socketio.emit('receive_message', {
            'id': msg_id,
            'user': '🤖 AIアドバイザー', 
            'message': answer_text,
            'read_count': 1
        }, room=room)

@socketio.on('ask_ai')
def on_ask_ai(data):
    prompt = data.get('prompt', 'ブレインストーミングの提案をしてください。')
    room = data.get('room', 'main_room')
    
    socketio.emit('receive_message', {
        'id': 0,
        'user': '🤖 AIアドバイザー',
        'message': f'「{prompt}」について思考中...',
        'read_count': 1
    }, room=room)
    
    thread = threading.Thread(target=async_ai_task, args=(prompt, app, room))
    thread.daemon = True
    thread.start()

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
        inspector = sqlalchemy.inspect(db.engine)
        if 'chat_message' in inspector.get_table_names():
            columns = [col['name'] for col in inspector.get_columns('chat_message')]
            with db.engine.connect() as conn:
                if 'read_count' not in columns:
                    conn.execute(sqlalchemy.text('ALTER TABLE chat_message ADD COLUMN read_count INTEGER DEFAULT 1'))
                    conn.commit()
                if 'is_deleted' not in columns:
                    conn.execute(sqlalchemy.text('ALTER TABLE chat_message ADD COLUMN is_deleted BOOLEAN DEFAULT 0'))
                    conn.commit()

    start_ollama_automatically()
    socketio.run(app, debug=True, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)