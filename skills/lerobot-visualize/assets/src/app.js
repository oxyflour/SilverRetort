import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";

const host=document.querySelector("#viewport"), state=document.querySelector("#state"), detail=document.querySelector("#detail");
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x09111b); scene.fog=new THREE.Fog(0x09111b,8,30);
const camera=new THREE.PerspectiveCamera(50,innerWidth/innerHeight,.01,100); camera.position.set(.8,-4.5,2.7); camera.up.set(0,0,1);
const renderer=new THREE.WebGLRenderer({antialias:true}); renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setSize(innerWidth,innerHeight); renderer.outputColorSpace=THREE.SRGBColorSpace; host.append(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement); controls.target.set(.4,0,.6); controls.enableDamping=true;
scene.add(new THREE.HemisphereLight(0xb9dcff,0x17212a,2.2)); const sun=new THREE.DirectionalLight(0xffffff,2.5); sun.position.set(4,-3,6); scene.add(sun);
const grid=new THREE.GridHelper(12,60,0x36546a,0x1d3040).rotateX(Math.PI/2); scene.add(grid);
const links=new Map(); const staticRoot=new THREE.Group(); scene.add(staticRoot);
function material(shape){
  if(shape.path.endsWith("/PickCube"))return new THREE.MeshStandardMaterial({color:0xff7a18,emissive:0x5a1800,roughness:.35,metalness:.05});
  if(shape.path.endsWith("/PlaceTarget"))return new THREE.MeshStandardMaterial({color:0x22c55e,emissive:0x063b1b,transparent:true,opacity:.85,roughness:.4});
  if(shape.path.includes("/PickPlaceWorkspace/Table"))return new THREE.MeshStandardMaterial({color:0x71869a,transparent:true,opacity:.55,roughness:.55,side:THREE.DoubleSide,depthWrite:false});
  return new THREE.MeshStandardMaterial({color:0x24a6d9,transparent:true,opacity:.45,roughness:.42,metalness:.05,side:THREE.DoubleSide,depthWrite:false});
}
function orientAxis(g,axis){if(axis==="X")return g.rotateZ(-Math.PI/2);if(axis==="Z")return g.rotateX(Math.PI/2);return g;}
function geometry(shape){if(shape.type==="box")return new THREE.BoxGeometry(...shape.size);if(shape.type==="sphere")return new THREE.SphereGeometry(shape.radius,24,16);if(shape.type==="capsule")return orientAxis(new THREE.CapsuleGeometry(shape.radius,shape.height,8,16),shape.axis);if(shape.type==="cylinder")return orientAxis(new THREE.CylinderGeometry(shape.radius,shape.radius,shape.height,24),shape.axis);if(shape.type==="mesh"){const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(shape.vertices,3));g.setIndex(shape.indices);g.computeVertexNormals();return g;}return null;}
fetch("/collision.json").then(r=>{if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json()}).then(data=>{const floors=data.shapes.filter(s=>!s.frame&&s.type==="box").map(s=>s.matrix[14]-(Math.abs(s.matrix[2])*s.size[0]+Math.abs(s.matrix[6])*s.size[1]+Math.abs(s.matrix[10])*s.size[2])/2);if(floors.length)grid.position.z=Math.min(...floors);for(const shape of data.shapes){const g=geometry(shape);if(!g)continue;const mesh=new THREE.Mesh(g,material(shape));mesh.matrixAutoUpdate=false;mesh.matrix.fromArray(shape.matrix);let root=staticRoot;if(shape.frame){if(!links.has(shape.frame)){const group=new THREE.Group();group.matrixAutoUpdate=false;links.set(shape.frame,group);scene.add(group);}root=links.get(shape.frame);}root.add(mesh);}detail.textContent=`${data.shapes.length} collision shapes · waiting for /tf`;}).catch(e=>setStatus("error","Scene error",e.message));
function setStatus(cls,label,text){state.className=cls;state.querySelector("span").textContent=label;detail.textContent=text;}
function connect(){const protocol=location.protocol==="https:"?"wss":"ws";const ws=new WebSocket(`${protocol}://${location.host}/ws`);ws.onopen=()=>setStatus("live","Connected",`0 poses received`);ws.onmessage=e=>{const msg=JSON.parse(e.data);let count=0;for(const pose of msg.transforms||[]){const group=links.get(pose.frame);if(!group)continue;group.position.fromArray(pose.translation);group.quaternion.fromArray(pose.rotation);group.updateMatrix();count++;}setStatus("live","Live",`${count} collision links · ${msg.stamp??"latest"}`);};ws.onclose=()=>{setStatus("","Reconnecting…","ROS bridge unavailable");setTimeout(connect,1000)};ws.onerror=()=>ws.close();}connect();
addEventListener("resize",()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera)});
